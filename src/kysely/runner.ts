/**
 * A runner for `.sql` migrations on top of a ready `Kysely`.
 *
 * Kysely is the only abstraction over the driver: under `pg` that is
 * `PostgresDialect`, under Bun any postgres dialect over `Bun.SQL` (the repository
 * has a test one, `test/helpers/bun-dialect.ts`). The runner needs one connection
 * for the whole run, the advisory lock and the transaction live on it, so it works
 * through `db.connection()`.
 *
 * Compatible with Kysely's `Migrator`: the same `kysely_migration` journal
 * (`name varchar(255)`, `timestamp varchar(255)` in ISO) and the same lock key as
 * `PostgresAdapter`. The two runners can alternate on one database and will not
 * run at the same time.
 *
 * Why a runner of our own when `Migrator` exists: that one is built around modules
 * with `up`/`down`. Here there are flat `.sql` files, a status without applying,
 * an error naming the failing statement and three transaction modes. Whoever is
 * happy with `Migrator` takes `sqlFileMigrationProvider`.
 */
import { type Kysely, sql } from 'kysely';

import { listMigrations, type MigrationFile, NO_TRANSACTION_MARKER, readMigration } from '../migrator/store.ts';

/** Same as Kysely, so both runners see one state. */
export const DEFAULT_JOURNAL_TABLE = 'kysely_migration';

/** The `pg_advisory_lock` key, the same as Kysely's `PostgresAdapter` uses. */
export const MIGRATION_LOCK_ID = 3853314791062309107n;

/** How long to wait for another run. An hour, like Kysely. */
const LOCK_TIMEOUT_MS = 60 * 60 * 1000;

export type TransactionMode = 'all' | 'each' | 'none';

export interface MigratorOptions {
  /**
   * A ready `Kysely` with any postgres dialect. Not a `Transaction`: the runner
   * opens transactions and takes the lock itself.
   */
  readonly db: Kysely<any>;
  /** The folder with `.sql` migrations, the same one `writeMigration` writes to. */
  readonly migrationsDir: string;
  /** The journal table. `kysely_migration` by default, like Kysely. */
  readonly journalTable?: string;
  /**
   * `each` (default): a transaction per migration; a migration with
   * `--> no-transaction` in its header, which is how the generator writes
   * `CREATE INDEX CONCURRENTLY`, runs without one. `all`: the whole run in one
   * transaction, like Kysely, so a failing migration rolls back the previous ones
   * from the same run; the marker is an error here, one shared transaction cannot
   * leave a migration out. `none`: no `BEGIN` at all; a plain file still runs as
   * one implicit transaction, since postgres treats a multi-statement query that way.
   */
  readonly transaction?: TransactionMode;
  /**
   * Allow migrations that sort before already applied ones (two branches each
   * added a migration and merged out of name order). An error by default.
   */
  readonly allowUnordered?: boolean;
}

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export interface MigrationRunResult {
  /** What this particular run applied, in application order. */
  readonly applied: readonly string[];
}

export interface SqlMigrator {
  /** What is applied and what is pending. Also checks that the journal and the folder agree. */
  status(): Promise<MigrationStatus>;
  /** Applies everything pending. A failing statement throws `MigrationError`. */
  toLatest(): Promise<MigrationRunResult>;
}

/** A failing query: which migration, which text and what was applied before it. */
export class MigrationError extends Error {
  override readonly name = 'MigrationError';

  /**
   * The line inside `statement` postgres pointed at, when it did. A generated
   * migration is one query with several statements, so this is what locates
   * the failing one.
   */
  readonly line: number | undefined;

  constructor(
    readonly migration: string,
    /** The text sent as one query: a whole file, or one chunk between `--> statement-breakpoint` markers. */
    readonly statement: string,
    /** Migrations applied by this run before the error. With `transaction: 'all'` they are rolled back. */
    readonly applied: readonly string[],
    cause: unknown,
  ) {
    const line = lineOf(statement, cause);
    super(`${migration}: statement failed${line === undefined ? '' : ` at line ${line}`}\n${statement}\n${describe(cause)}`, { cause });
    this.line = line;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Postgres reports the error position as a 1-based character offset into the query; both drivers pass it on. */
function lineOf(statement: string, cause: unknown): number | undefined {
  const position = Number((cause as { position?: unknown } | null)?.position);

  if (!Number.isInteger(position) || position < 1) {
    return undefined;
  }

  return statement.slice(0, position - 1).split('\n').length;
}

export function createMigrator(options: MigratorOptions): SqlMigrator {
  const { db, migrationsDir: dir } = options;

  if (db.isTransaction) {
    throw new Error('createMigrator: pass a Kysely instance, not a Transaction: the runner manages transactions and the lock itself');
  }

  const journal = options.journalTable ?? DEFAULT_JOURNAL_TABLE;

  if (!/^[a-z_][a-z0-9_]*$/i.test(journal)) {
    throw new Error(`journalTable: "${journal}" may only contain letters, digits and underscores`);
  }

  const table = sql.table(journal);
  const mode = options.transaction ?? 'each';
  const allowUnordered = options.allowUnordered ?? false;

  return {
    status: () =>
      db.connection().execute(async connection => {
        await ensureJournal(connection, table);

        return readState(connection, table, dir, allowUnordered);
      }),

    toLatest: () =>
      db.connection().execute(connection =>
        withLock(connection, async () => {
          await ensureJournal(connection, table);
          const state = await readState(connection, table, dir, allowUnordered);

          return apply(connection, table, dir, state.pending, mode);
        }),
      ),
  };
}

/** `createMigrator(options).toLatest()` in one line. */
export function migrateToLatest(options: MigratorOptions): Promise<MigrationRunResult> {
  return createMigrator(options).toLatest();
}

// ── internals ────────────────────────────────────────────────────────────────

type Connection = Kysely<any>;
type Journal = ReturnType<typeof sql.table>;

/** A pending migration with its file already parsed. */
interface PendingMigration extends MigrationFile {
  readonly name: string;
}

async function run(connection: Connection, statement: string): Promise<void> {
  await sql.raw(statement).execute(connection);
}

async function withLock<T>(connection: Connection, fn: () => Promise<T>): Promise<T> {
  // set_config(..., true) lasts until the end of the current transaction; outside BEGIN that is exactly one statement
  await run(
    connection,
    `with set_timeout as (select set_config('lock_timeout', '${LOCK_TIMEOUT_MS}', true)) ` +
      `select pg_advisory_lock(${MIGRATION_LOCK_ID}) from set_timeout`,
  );

  const unlock = `select pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  let result: T;

  try {
    result = await fn();
  } catch (error) {
    // if the connection died, the server released the lock itself; keeping the original error matters more
    await run(connection, unlock).catch(() => undefined);
    throw error;
  }

  await run(connection, unlock);

  return result;
}

async function ensureJournal(connection: Connection, table: Journal): Promise<void> {
  await sql`create table if not exists ${table} ("name" varchar(255) not null primary key, "timestamp" varchar(255) not null)`.execute(
    connection,
  );
}

async function readState(
  connection: Connection,
  table: Journal,
  dir: string,
  allowUnordered: boolean,
): Promise<MigrationStatus> {
  const files = listMigrations(dir);
  const { rows } = await sql<{ name: string }>`select "name" from ${table}`.execute(connection);
  // sort here, by character codes, like the files and like Kysely, not by the database collation
  const applied = rows.map(row => row.name).toSorted();

  const onDisk = new Set(files);
  const missing = applied.filter(name => !onDisk.has(name));

  if (missing.length > 0) {
    throw new Error(
      `${dir}: the journal has migrations that are missing on disk: ${missing.join(', ')}. ` +
        'Restore the files from history or delete the journal rows by hand.',
    );
  }

  const done = new Set(applied);
  const pending = files.filter(name => !done.has(name));
  const last = applied.at(-1);

  if (!allowUnordered && last !== undefined) {
    const outOfOrder = pending.filter(name => name < last);

    if (outOfOrder.length > 0) {
      throw new Error(
        `${dir}: migrations ${outOfOrder.join(', ')} sort before the already applied ${last}. ` +
          'Rename them with a newer timestamp or pass allowUnordered: true.',
      );
    }
  }

  return { applied, pending };
}

async function apply(
  connection: Connection,
  table: Journal,
  dir: string,
  pending: readonly string[],
  mode: TransactionMode,
): Promise<MigrationRunResult> {
  const applied: string[] = [];

  if (pending.length === 0) {
    return { applied };
  }

  // parse everything first: a malformed file, or a marker the mode cannot honor,
  // must fail before the first statement reaches the database
  const migrations: PendingMigration[] = pending.map(name => ({ name, ...readMigration(dir, name) }));
  const marked = migrations.find(migration => !migration.transaction);

  // under 'none' the marker asks for what already happens; under 'all' it cannot be honored
  if (marked !== undefined && mode === 'all') {
    throw new Error(
      `${dir}: ${marked.name} is marked "${NO_TRANSACTION_MARKER}", but transaction: 'all' runs the whole run ` +
        "in one transaction and cannot leave a migration out. Use transaction: 'each'.",
    );
  }

  const runOne = async ({ name, statements }: PendingMigration): Promise<void> => {
    for (const statement of statements) {
      try {
        await run(connection, statement);
      } catch (error) {
        throw new MigrationError(name, statement, [...applied], error);
      }
    }

    await sql`insert into ${table} ("name", "timestamp") values (${name}, ${new Date().toISOString()})`.execute(connection);
    applied.push(name);
  };

  // begin/commit by hand, on the same connection: PostgresDriver inside Kysely does the same
  const inTransaction = async (fn: () => Promise<void>): Promise<void> => {
    await run(connection, 'begin');

    try {
      await fn();
    } catch (error) {
      await run(connection, 'rollback').catch(() => undefined);
      throw error;
    }

    await run(connection, 'commit');
  };

  switch (mode) {
    case 'all':
      await inTransaction(async () => {
        for (const migration of migrations) {
          await runOne(migration);
        }
      });
      break;

    case 'each':
      for (const migration of migrations) {
        // a marked migration runs in autocommit, its journal row too, like Kysely's 'per-migration' mode
        if (migration.transaction) {
          await inTransaction(() => runOne(migration));
        } else {
          await runOne(migration);
        }
      }

      break;

    case 'none':
      for (const migration of migrations) {
        await runOne(migration);
      }

      break;
  }

  return { applied };
}
