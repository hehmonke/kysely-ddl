/**
 * Migrations on disk: flat `.sql` files next to a single snapshot.
 *
 * ```
 * migrations/
 *   20260910120000_init.sql
 *   20260910123000_add_tickets.sql
 *   snapshot.json
 * ```
 *
 * There is no separate journal: the file list is the journal, and what has been
 * applied is known to `kysely_migration` in the database itself. The file name
 * without the extension is also the migration name for `Migrator`, hence the
 * timestamp prefix: Kysely sorts migrations as strings.
 *
 * There is a single snapshot describing the state after the LATEST migration,
 * which is all that is needed to compute the next diff. The price is merge
 * conflicts: two branches that each add a migration diverge in one file, and
 * the snapshot has to be regenerated after the merge.
 *
 * Inside a file, `-->` comments are markers for the runner; postgres sees plain
 * comments. `--> statement-breakpoint` separates statements, and
 * `--> no-transaction` in the header says the migration runs outside a transaction.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GenerateResult } from '../generator/generate.ts';
import { EMPTY_SNAPSHOT, type Snapshot } from '../generator/snapshot.ts';

export const MIGRATION_EXTENSION = '.sql';
export const SNAPSHOT_FILE = 'snapshot.json';

/** Machine-readable comments start with this. */
const MARKER = '-->';
const NO_TRANSACTION = 'no-transaction';

/**
 * Separator between statements inside a file. It is an SQL comment, so the file
 * stays valid when fed to psql as a whole.
 */
export const STATEMENT_SEPARATOR = '--> statement-breakpoint';

/**
 * A header marker: the migration runs outside a transaction, which postgres
 * demands for `CREATE INDEX CONCURRENTLY` and the like. Recognized only in the
 * header, that is, among the blank lines and comments before the first statement.
 *
 * The runner honors it under `transaction: 'each'`. For Kysely's `Migrator` the
 * provider turns it into `config: { transaction: false }`, which Kysely 0.30+
 * honors under `transactionMode: 'per-migration'`.
 */
export const NO_TRANSACTION_MARKER = `${MARKER} ${NO_TRANSACTION}`;

/** Parses the file name prefix back into a date. */
function parseTimestamp(value: string): Date {
  return new Date(
    Date.UTC(
      Number(value.slice(0, 4)),
      Number(value.slice(4, 6)) - 1,
      Number(value.slice(6, 8)),
      Number(value.slice(8, 10)),
      Number(value.slice(10, 12)),
      Number(value.slice(12, 14)),
    ),
  );
}

/** `20260910123045`: Kysely sorts migrations by name, hence this prefix. */
const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export function migrationTimestamp(now = new Date()): string {
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/** Migration names (without `.sql`), sorted the way Kysely sorts them: by character codes. */
export function listMigrations(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(MIGRATION_EXTENSION))
    .map(entry => entry.name.slice(0, -MIGRATION_EXTENSION.length))
    .toSorted();
}

/** The schema state after the latest migration; the next diff is computed from it. */
export function readLatestSnapshot(dir: string): Snapshot {
  const file = path.join(dir, SNAPSHOT_FILE);

  if (!fs.existsSync(file)) {
    if (listMigrations(dir).length > 0) {
      throw new Error(
        `${dir}: migrations exist but ${SNAPSHOT_FILE} is missing. ` +
          'Without it there is nothing to diff against: restore the file from history.',
      );
    }

    return EMPTY_SNAPSHOT;
  }

  return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
}

/** A parsed migration file. */
export interface MigrationFile {
  /** The statements, split on `STATEMENT_SEPARATOR`, with the header markers taken out. */
  readonly statements: readonly string[];
  /** `false` when the header carries `NO_TRANSACTION_MARKER`. */
  readonly transaction: boolean;
}

/** The word after `-->` on a marker line, undefined for any other line. */
function markerOf(line: string): string | undefined {
  return line.startsWith(MARKER) ? line.slice(MARKER.length).trim() : undefined;
}

/**
 * The header is everything before the first statement: blank lines, plain `--`
 * comments and markers. Markers are taken out, the rest goes to postgres as is.
 * A marker below the header would reach postgres as a comment and change
 * nothing, so it is an error rather than a silent no-op.
 */
function parseMigration(text: string, name: string): MigrationFile {
  const kept: string[] = [];
  let transaction = true;
  let inHeader = true;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const marker = markerOf(line);

    if (inHeader && marker !== undefined && line !== STATEMENT_SEPARATOR) {
      if (marker !== NO_TRANSACTION) {
        throw new Error(
          `${name}: unknown marker "${line}" in the header. The only header marker is "${NO_TRANSACTION_MARKER}".`,
        );
      }

      transaction = false;
      continue;
    }

    // the first statement, or a separator, ends the header
    if (inHeader && line !== '' && (marker !== undefined || !line.startsWith('--'))) {
      inHeader = false;
    }

    if (!inHeader && marker === NO_TRANSACTION) {
      throw new Error(`${name}: "${NO_TRANSACTION_MARKER}" must be in the header, before the first statement.`);
    }

    kept.push(raw);
  }

  const statements = kept
    .join('\n')
    .split(STATEMENT_SEPARATOR)
    .map(statement => statement.trim())
    .filter(statement => statement !== '');

  return { statements, transaction };
}

/** The statements of a migration and what its header markers said. */
export function readMigration(dir: string, name: string): MigrationFile {
  return parseMigration(fs.readFileSync(path.join(dir, `${name}${MIGRATION_EXTENSION}`), 'utf8'), name);
}

/** The statements only; `readMigration` also tells whether the migration wants a transaction. */
export function readStatements(dir: string, name: string): string[] {
  return [...readMigration(dir, name).statements];
}

/**
 * Names must grow monotonically: Kysely applies migrations in alphabetical
 * order. Two migrations created within the same second would get the same
 * prefix, and the suffix would decide the order, that is, by luck.
 */
function nextTimestamp(dir: string): string {
  const previous = listMigrations(dir).at(-1);
  const stamp = migrationTimestamp();

  if (previous !== undefined && stamp <= previous.slice(0, 14)) {
    return migrationTimestamp(new Date(parseTimestamp(previous.slice(0, 14)).getTime() + 1000));
  }

  return stamp;
}

/** The suffix of the migration that holds the `CONCURRENTLY` statements. */
export const CONCURRENTLY_SUFFIX = '_concurrently';

/**
 * Writes the migration files, updates the snapshot and returns the names in
 * application order.
 *
 * The ordinary statements go into `<stamp>_<name>.sql` as plain SQL: postgres
 * runs such a file as one query. The `CONCURRENTLY` statements, which postgres
 * refuses inside a transaction and inside a multi-statement query alike, go into
 * `<stamp+1>_<name>_concurrently.sql`, marked `--> no-transaction` and split by
 * `--> statement-breakpoint` so that the runner sends them one at a time.
 * Either file is skipped when it would be empty.
 */
export function writeMigration(dir: string, name: string, result: GenerateResult): string[] {
  if (result.statements.length === 0 && result.concurrently.length === 0) {
    throw new Error('nothing to write: no changes');
  }

  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`migration name "${name}": only [a-z0-9_] is allowed`);
  }

  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  const write = (suffix: string, text: string): void => {
    const migration = `${nextTimestamp(dir)}_${name}${suffix}`;
    const file = path.join(dir, `${migration}${MIGRATION_EXTENSION}`);

    if (fs.existsSync(file)) {
      throw new Error(`migration ${migration} already exists`);
    }

    fs.writeFileSync(file, text);
    written.push(migration);
  };

  if (result.statements.length > 0) {
    write('', result.sql);
  }

  if (result.concurrently.length > 0) {
    write(CONCURRENTLY_SUFFIX, `${NO_TRANSACTION_MARKER}\n${result.concurrently.join(`\n${STATEMENT_SEPARATOR}\n`)}\n`);
  }

  fs.writeFileSync(
    path.join(dir, SNAPSHOT_FILE),
    `${JSON.stringify(result.snapshot, null, 2)}\n`,
  );

  return written;
}
