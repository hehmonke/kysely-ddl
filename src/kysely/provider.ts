/**
 * Running migrations with Kysely's built-in `Migrator`.
 *
 * No runner of its own is needed here: Kysely already handles the lock
 * (`kysely_migration_lock`), the record of what has been applied
 * (`kysely_migration`), ordering and the transaction. The one thing it lacks is
 * loading migrations from anything but modules with `up`/`down` functions
 * (`FileMigrationProvider`), while we generate plain SQL. That is what
 * `sqlFileMigrationProvider` covers.
 *
 * ```ts
 * import { Migrator } from 'kysely/migration';
 *
 * const migrator = new Migrator({
 *   db,
 *   provider: sqlFileMigrationProvider('./migrations'),
 * });
 *
 * const { error, results } = await migrator.migrateToLatest();
 * ```
 *
 * On transactions: on postgres Kysely runs the WHOLE run in one transaction by
 * default, DDL is transactional there, so a failing migration rolls back all the
 * previous ones from the same run. A migration with `--> no-transaction` in its
 * header gets `config: { transaction: false }`, which Kysely 0.30+ honors under
 * `new Migrator({ ..., transactionMode: 'per-migration' })`: every migration in
 * its own transaction, the marked one without. Older Kysely ignores `config`, so
 * the marked migration checks that it is not inside a transaction and fails with
 * a clear error instead of a postgres one; there the only way out is
 * `disableTransactions: true` for the whole run.
 */
import { type Kysely, sql } from 'kysely';

import { listMigrations, NO_TRANSACTION_MARKER, readMigration } from '../migrator/store.ts';

import type { Migration, MigrationProvider } from 'kysely/migration';

export interface SqlMigrationProviderOptions {
  /**
   * What to do on `migrateDown` / `migrateTo`.
   *
   * The generator only writes forward, and migrations have no `down`. Without
   * `down`, Kysely skips the migration (`NotExecuted`) and leaves it in the
   * journal: `migrateDown` quietly does nothing. By default the provider supplies
   * a `down` that fails with a clear error: a rollback must not look successful.
   * `skip` restores Kysely's behaviour. A paired rollback, when needed, is
   * written by hand and wired through your own provider.
   */
  readonly onDown?: 'throw' | 'skip';
}

/** `Migration` plus the `config` field Kysely 0.30 reads; older versions ignore it. */
interface SqlMigration extends Migration {
  readonly config?: { readonly transaction: false };
}

/**
 * A provider that hands `.sql` files from a folder to the `Migrator`.
 * The migration name is the file name without the extension, the order is
 * alphabetical (hence the timestamp prefix).
 */
export function sqlFileMigrationProvider(
  dir: string,
  options: SqlMigrationProviderOptions = {},
): MigrationProvider {
  const onDown = options.onDown ?? 'throw';

  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const migrations: Record<string, Migration> = {};

      for (const name of listMigrations(dir)) {
        const file = readMigration(dir, name);

        const migration: SqlMigration = {
          async up(db: Kysely<unknown>): Promise<void> {
            if (!file.transaction && db.isTransaction) {
              throw new Error(
                `${name} is marked "${NO_TRANSACTION_MARKER}" but the Migrator runs it inside a transaction. ` +
                  "Kysely 0.30+: new Migrator({ ..., transactionMode: 'per-migration' }); older Kysely: " +
                  "disableTransactions: true; or kysely-ddl's createMigrator({ ..., transaction: 'each' }).",
              );
            }

            // chunk by chunk: a plain file is one chunk, a file with
            // `--> statement-breakpoint` several; CONCURRENTLY statements must travel alone
            for (const statement of file.statements) {
              await sql.raw(statement).execute(db);
            }
          },
          // only when marked: in Kysely's other transaction modes an explicit value is an error
          ...(file.transaction ? {} : { config: { transaction: false as const } }),
          ...(onDown === 'throw'
            ? {
                down(): Promise<void> {
                  return Promise.reject(
                    new Error(
                      `${name}: no rollback available. The generator only writes forward migrations: ` +
                        'write the reverse migration yourself or pass { onDown: "skip" }.',
                    ),
                  );
                },
              }
            : {}),
        };

        migrations[name] = migration;
      }

      return migrations;
    },
  };
}
