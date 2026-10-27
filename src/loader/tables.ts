/**
 * `loadTables`: glob patterns -> the tables `generateMigration` takes, and the
 * foreign keys `defineForeignKey` declares outside them, so that a schema spread
 * over many files is pointed at instead of being listed by hand:
 *
 * ```ts
 * const tables = await loadTables('../schema-core/src/lib/tables/**\/*.table.ts');
 * const result = generateMigration(tables, readLatestSnapshot(dir));
 * ```
 *
 * This is for generation only. Kysely's row types come from a static
 * `import * as schema`, as before: a glob is resolved when the script runs, and
 * TypeScript cannot see through it.
 *
 * The loading is deliberately strict, because the failure mode is expensive: a
 * table the glob misses is not "missing", it is missing from the diff, and the
 * generated migration drops it. So an empty match, a file that fails to import
 * and a reference to a table outside the match are all errors, not warnings.
 */
import { pathToFileURL } from 'node:url';

import { type AnyTable, type ForeignKey, isForeignKey, isTable, type SchemaObject } from '../table/define.ts';

import { globFiles } from './glob.ts';

export interface LoadTablesOptions {
  /** Directory the relative patterns resolve against; `process.cwd()` by default. */
  readonly cwd?: string;
}

/**
 * Imports one matched file. Failures are rethrown with the file in the message:
 * the stack of a transitive import error rarely says which schema file pulled it in.
 */
async function importFile(file: string): Promise<Record<string, unknown>> {
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const hint = file.endsWith('.ts')
      ? ' Importing .ts at runtime needs a runtime that understands it: bun, node with type stripping, or a loader such as tsx.'
      : '';

    throw new Error(`loadTables: cannot import ${file}: ${reason}.${hint}`, { cause: error });
  }
}

interface Found<T> {
  readonly value: T;
  readonly file: string;
  /** The export it was found under; for error messages. */
  readonly key: string;
}

/**
 * A foreign key to a table no matched file exports means the glob is too narrow.
 * Left alone it would generate a `REFERENCES` to a table the snapshot does not
 * know, and the migration would fail on apply — or, worse, the missing tables
 * would look dropped.
 */
function assertSelfContained(tables: readonly Found<AnyTable>[], foreignKeys: readonly Found<ForeignKey>[]): void {
  const names = new Set(tables.map(entry => entry.value.spec.name));
  const tooNarrow = 'The pattern is too narrow: widen it, or the generated migration would reference a table the snapshot does not have.';

  for (const entry of tables) {
    for (const foreignKey of entry.value.spec.foreignKeys) {
      if (!names.has(foreignKey.refTable)) {
        throw new Error(
          `loadTables: table "${entry.value.spec.name}" (${entry.file}) references "${foreignKey.refTable}", ` +
            `which none of the matched files exports. ${tooNarrow}`,
        );
      }
    }
  }

  for (const entry of foreignKeys) {
    const { table, spec } = entry.value;

    // the same object, not just the name: the key was resolved against its columns
    if (!tables.some(found => found.value === table)) {
      throw new Error(
        `loadTables: foreign key "${spec.name}" (${entry.file}) belongs to table "${table.spec.name}", ` +
          'which none of the matched files exports. The pattern is too narrow: widen it, the key cannot be ' +
          'generated without its table.',
      );
    }

    if (!names.has(spec.refTable)) {
      throw new Error(
        `loadTables: foreign key "${spec.name}" (${entry.file}) references "${spec.refTable}", ` +
          `which none of the matched files exports. ${tooNarrow}`,
      );
    }
  }
}

/**
 * Finds the files, imports them and collects every exported table, sorted by
 * table name so that the result does not depend on where a table lives, then
 * every exported `defineForeignKey` key, sorted by table and key name. Both go
 * into the one list `generateMigration` takes.
 *
 * A table or a key exported from several files, a barrel for instance, is counted once.
 * Two different tables with the same database name are an error, as they are for
 * `generateMigration`, but the message names the files.
 */
export async function loadTables(
  patterns: string | readonly string[],
  options: LoadTablesOptions = {},
): Promise<SchemaObject[]> {
  const list = typeof patterns === 'string' ? [patterns] : [...patterns];
  const cwd = options.cwd ?? process.cwd();
  const quoted = list.map(pattern => `"${pattern}"`).join(', ');

  if (list.length === 0) {
    throw new Error('loadTables: no patterns given.');
  }

  if (list.every(pattern => pattern.startsWith('!'))) {
    throw new Error(`loadTables: ${quoted}: nothing to match, a "!" pattern only excludes.`);
  }

  const files = globFiles(list, cwd);

  if (files.length === 0) {
    throw new Error(
      `loadTables: nothing matches ${quoted} (relative to ${posixCwd(cwd)}). ` +
        'Check the path and the extension; wildcards do not match dot-directories or node_modules.',
    );
  }

  const found: Found<AnyTable>[] = [];
  const foreignKeys: Found<ForeignKey>[] = [];
  const seen = new Set<unknown>();
  const byName = new Map<string, Found<AnyTable>>();

  for (const file of files) {
    const module = await importFile(file);

    for (const [key, value] of Object.entries(module)) {
      if (seen.has(value)) {
        continue;
      }

      if (isForeignKey(value)) {
        seen.add(value);
        foreignKeys.push({ value, file, key });
        continue;
      }

      if (!isTable(value)) {
        continue;
      }

      seen.add(value);
      const name = value.spec.name;
      const previous = byName.get(name);

      if (previous !== undefined) {
        throw new Error(
          `loadTables: two different tables are named "${name}": ` +
            `${previous.key} in ${previous.file} and ${key} in ${file}.`,
        );
      }

      const entry: Found<AnyTable> = { value, file, key };
      byName.set(name, entry);
      found.push(entry);
    }
  }

  if (found.length === 0) {
    throw new Error(
      `loadTables: ${files.length} file(s) match ${quoted}, but none of them exports a table. ` +
        'Tables must be exported from the matched files (`export const userTable = defineTable(...)`).',
    );
  }

  assertSelfContained(found, foreignKeys);

  const tables = found.map(entry => entry.value).toSorted((a, b) => compareNames(a.spec.name, b.spec.name));
  const keys = foreignKeys
    .map(entry => entry.value)
    .toSorted((a, b) => compareNames(a.table.spec.name, b.table.spec.name) || compareNames(a.spec.name, b.spec.name));

  return [...tables, ...keys];
}

function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}

/** `cwd` in the same shape as the paths in the rest of the messages. */
function posixCwd(cwd: string): string {
  return cwd.replaceAll('\\', '/');
}
