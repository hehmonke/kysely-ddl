/**
 * A snapshot is the serialized schema state. The diff is computed snapshot vs
 * schema, not database vs schema: postgres normalizes expressions on save
 * (`x in (...)` -> `x = ANY (ARRAY[...])`, `trim(x)` -> `TRIM(BOTH FROM x)`),
 * and reading back from the database yields a perpetual diff on the same checks.
 *
 * The price is that database drift is invisible to the snapshot. This is a
 * deliberate trade: migration generation must be deterministic, and drift
 * detection is a separate tool's job.
 */
import type { DefaultValue } from '../table/columns.ts';
import {
  type AnyTable,
  type ForeignKey,
  type IndexKey,
  type IndexMethod,
  isForeignKey,
  type ReferentialAction,
  type SchemaObject,
  type TableSpec,
  withForeignKeys,
} from '../table/define.ts';
import { isSql, quoteLiteral, renderSql } from '../table/sql.ts';

export const SNAPSHOT_VERSION = 1;

export interface ColumnSnapshot {
  readonly name: string;
  /** The final postgres type, including `[]` for arrays. */
  readonly type: string;
  readonly notNull: boolean;
  /** The rendered default SQL, or null. */
  readonly default: string | null;
  readonly identity: 'always' | 'byDefault' | null;
}

/**
 * An index key. A plain column is its name, the form every snapshot had before
 * keys got options, so those snapshots read unchanged. A key with an operator
 * class, a sort order or an expression is an object; options equal to the
 * postgres defaults (`asc`, `nulls last` for asc, `nulls first` for desc) are
 * left out, so spelling a default out is not a change.
 */
export type IndexColumnSnapshot =
  | string
  | {
      readonly column?: string;
      /** The rendered expression, without the parentheses the index wraps it in. */
      readonly expression?: string;
      readonly opclass?: string;
      readonly order?: 'desc';
      readonly nulls?: 'first' | 'last';
    };

export interface TableSnapshot {
  readonly name: string;
  readonly columns: readonly ColumnSnapshot[];
  readonly primaryKey: { readonly name: string; readonly columns: readonly string[] } | null;
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: boolean;
    /**
     * The access method, present only when it is not btree: snapshots of btree
     * indexes, the ones written before the field existed included, lack it.
     */
    readonly using?: IndexMethod;
    readonly columns: readonly IndexColumnSnapshot[];
    readonly where: string | null;
    /**
     * Built and dropped with `CONCURRENTLY`. How the index is built, not what it
     * is: the diff ignores it when comparing indexes. Snapshots written before
     * the field existed simply lack it, which reads as `false`.
     */
    readonly concurrently: boolean;
  }[];
  readonly foreignKeys: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly refTable: string;
    readonly refColumns: readonly string[];
    readonly onDelete: ReferentialAction | null;
    readonly onUpdate: ReferentialAction | null;
  }[];
  readonly checks: readonly { readonly name: string; readonly expression: string }[];
}

export interface Snapshot {
  readonly version: number;
  readonly tables: readonly TableSnapshot[];
}

export const EMPTY_SNAPSHOT: Snapshot = { version: SNAPSHOT_VERSION, tables: [] };

function renderDefault(value: DefaultValue | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  if (isSql(value)) {
    return renderSql(value);
  }

  return quoteLiteral(value);
}

function indexColumnSnapshot(key: IndexKey): IndexColumnSnapshot {
  const order = key.order === 'desc' ? 'desc' : undefined;
  const defaultNulls = order === 'desc' ? 'first' : 'last';
  const nulls = key.nulls === defaultNulls ? undefined : key.nulls;

  if (key.column !== undefined && key.opclass === undefined && order === undefined && nulls === undefined) {
    return key.column;
  }

  return {
    ...(key.column === undefined ? {} : { column: key.column }),
    ...(key.expression === undefined ? {} : { expression: renderSql(key.expression) }),
    ...(key.opclass === undefined ? {} : { opclass: key.opclass }),
    ...(order === undefined ? {} : { order }),
    ...(nulls === undefined ? {} : { nulls }),
  };
}

function tableSnapshot(spec: TableSpec): TableSnapshot {
  return {
    name: spec.name,
    columns: spec.columns.map(column => ({
      name: column.name,
      type: column.array ? `${column.sqlType}[]` : column.sqlType,
      notNull: column.notNull,
      default: renderDefault(column.default),
      identity: column.identity ?? null,
    })),
    primaryKey: spec.primaryKey !== undefined
      ? { name: spec.primaryKey.name, columns: [...spec.primaryKey.columns] }
      : null,
    uniques: spec.uniques.map(u => ({ name: u.name, columns: [...u.columns] })),
    indexes: spec.indexes.map(i => ({
      name: i.name,
      unique: i.unique,
      ...(i.using === undefined || i.using === 'btree' ? {} : { using: i.using }),
      columns: i.columns.map(indexColumnSnapshot),
      where: i.where !== undefined ? renderSql(i.where) : null,
      concurrently: i.concurrently,
    })),
    foreignKeys: spec.foreignKeys.map(f => ({
      name: f.name,
      columns: [...f.columns],
      refTable: f.refTable,
      refColumns: [...f.refColumns],
      onDelete: f.onDelete ?? null,
      onUpdate: f.onUpdate ?? null,
    })),
    checks: spec.checks.map(c => ({ name: c.name, expression: renderSql(c.expression) })),
  };
}

/**
 * Schema (tables and the foreign keys declared outside them) -> snapshot.
 *
 * Tables are ordered by name, so the snapshot and the CREATE TABLE order of a
 * migration do not depend on how the caller collected the list: a hand-written
 * array, a module's exports and `loadTables` give the same file. The comparison
 * is by UTF-16 code unit, not `localeCompare`, whose order changes with the
 * machine's locale. A key from `defineForeignKey` goes into its table after the
 * table's own keys, ordered by name for the same reason.
 */
export function buildSnapshot(schema: readonly SchemaObject[]): Snapshot {
  const tables = new Map<string, AnyTable>();
  const outside = new Map<string, ForeignKey[]>();

  for (const entry of schema) {
    if (isForeignKey(entry)) {
      continue;
    }

    if (tables.has(entry.spec.name)) {
      throw new Error(`table "${entry.spec.name}" is declared twice`);
    }
    tables.set(entry.spec.name, entry);
  }

  for (const entry of schema) {
    if (!isForeignKey(entry)) {
      continue;
    }

    const name = entry.table.spec.name;
    const table = tables.get(name);

    if (table === undefined) {
      throw new Error(`foreign key "${entry.spec.name}" belongs to table "${name}", which is not among the tables passed`);
    }

    // the same object, not just the name: the key was resolved against its columns
    if (table !== entry.table) {
      throw new Error(
        `foreign key "${entry.spec.name}" belongs to another definition of table "${name}" than the one passed`,
      );
    }

    const keys = outside.get(name) ?? [];

    if (keys.includes(entry)) {
      throw new Error(`foreign key "${entry.spec.name}" is passed twice`);
    }
    outside.set(name, [...keys, entry]);
  }

  const withOutside = (table: AnyTable): TableSpec =>
    withForeignKeys(
      table.spec,
      (outside.get(table.spec.name) ?? []).map(key => key.spec).toSorted((a, b) => compareNames(a.name, b.name)),
    );

  return {
    version: SNAPSHOT_VERSION,
    tables: [...tables.values()].map(t => tableSnapshot(withOutside(t))).toSorted((a, b) => compareNames(a.name, b.name)),
  };
}

function compareNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  return a < b ? -1 : 1;
}
