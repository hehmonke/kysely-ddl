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
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GenerateResult } from '../generator/generate.ts';
import { EMPTY_SNAPSHOT, type Snapshot } from '../generator/snapshot.ts';

export const MIGRATION_EXTENSION = '.sql';
export const SNAPSHOT_FILE = 'snapshot.json';

/**
 * Separator between statements inside a file. It is an SQL comment, so the file
 * stays valid when fed to psql as a whole.
 */
export const STATEMENT_SEPARATOR = '--> statement-breakpoint';

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

export function readStatements(dir: string, name: string): string[] {
  const text = fs.readFileSync(path.join(dir, `${name}${MIGRATION_EXTENSION}`), 'utf8');

  return text
    .split(STATEMENT_SEPARATOR)
    .map(statement => statement.trim())
    .filter(statement => statement !== '');
}

/** Writes the migration file, updates the snapshot and returns the migration name. */
export function writeMigration(dir: string, name: string, result: GenerateResult): string {
  if (result.statements.length === 0) {
    throw new Error('nothing to write: no changes');
  }

  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`migration name "${name}": only [a-z0-9_] is allowed`);
  }

  // Names must grow monotonically: Kysely applies migrations in alphabetical
  // order. Two migrations created within the same second would get the same
  // prefix, and the suffix would decide the order, that is, by luck.
  const previous = listMigrations(dir).at(-1);
  let stamp = migrationTimestamp();

  if (previous !== undefined && stamp <= previous.slice(0, 14)) {
    stamp = migrationTimestamp(new Date(parseTimestamp(previous.slice(0, 14)).getTime() + 1000));
  }

  const migration = `${stamp}_${name}`;
  const file = path.join(dir, `${migration}${MIGRATION_EXTENSION}`);

  if (fs.existsSync(file)) {
    throw new Error(`migration ${migration} already exists`);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${result.statements.join(`\n${STATEMENT_SEPARATOR}\n`)}\n`);
  fs.writeFileSync(
    path.join(dir, SNAPSHOT_FILE),
    `${JSON.stringify(result.snapshot, null, 2)}\n`,
  );

  return migration;
}
