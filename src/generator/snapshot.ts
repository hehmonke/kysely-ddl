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
import type { AnyTable, ReferentialAction, TableSpec } from '../table/define.ts';
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

export interface TableSnapshot {
  readonly name: string;
  readonly columns: readonly ColumnSnapshot[];
  readonly primaryKey: { readonly name: string; readonly columns: readonly string[] } | null;
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
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
      columns: [...i.columns],
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

/** Schema (a list of tables) -> snapshot. */
export function buildSnapshot(tables: readonly AnyTable[]): Snapshot {
  const seen = new Set<string>();

  for (const table of tables) {
    if (seen.has(table.spec.name)) {
      throw new Error(`table "${table.spec.name}" is declared twice`);
    }
    seen.add(table.spec.name);
  }

  return { version: SNAPSHOT_VERSION, tables: tables.map(t => tableSnapshot(t.spec)) };
}
