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
 * previous ones from the same run. It is disabled with
 * `new Migrator({ ..., disableTransactions: true })`; that is needed for
 * operations postgres forbids inside a transaction (`CREATE INDEX CONCURRENTLY`
 * and the like).
 */
import { type Kysely, sql } from 'kysely';

import { listMigrations, readStatements } from '../migrator/store.ts';

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
        migrations[name] = {
          async up(db: Kysely<unknown>): Promise<void> {
            // one statement at a time: the driver does not trip over
            // multi-statement text, and an error points at a specific query
            for (const statement of readStatements(dir, name)) {
              await sql.raw(statement).execute(db);
            }
          },
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
      }

      return migrations;
    },
  };
}
