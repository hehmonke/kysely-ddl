/**
 * Diff of two snapshots -> an ordered list of changes.
 *
 * Order matters more than completeness: first drop what gets in the way (indexes,
 * constraints), then create, then drop columns and tables. Foreign keys go last as
 * separate ALTERs, otherwise the CREATE TABLE order would start to matter.
 */
import type { ColumnSnapshot, Snapshot, TableSnapshot } from './snapshot.ts';

type Index = TableSnapshot['indexes'][number];
type ForeignKey = TableSnapshot['foreignKeys'][number];
type Unique = TableSnapshot['uniques'][number];
type Check = TableSnapshot['checks'][number];
type PrimaryKey = NonNullable<TableSnapshot['primaryKey']>;

export type Constraint =
  | { readonly type: 'primaryKey'; readonly def: PrimaryKey }
  | { readonly type: 'unique'; readonly def: Unique }
  | { readonly type: 'check'; readonly def: Check }
  | { readonly type: 'foreignKey'; readonly def: ForeignKey };

export type Change =
  | { readonly kind: 'createTable'; readonly table: TableSnapshot }
  | { readonly kind: 'dropTable'; readonly table: string }
  | { readonly kind: 'addColumn'; readonly table: string; readonly column: ColumnSnapshot }
  | { readonly kind: 'dropColumn'; readonly table: string; readonly column: string }
  | {
      readonly kind: 'alterColumn';
      readonly table: string;
      readonly from: ColumnSnapshot;
      readonly to: ColumnSnapshot;
    }
  | { readonly kind: 'addConstraint'; readonly table: string; readonly constraint: Constraint }
  | { readonly kind: 'dropConstraint'; readonly table: string; readonly name: string }
  | {
      /** DROP + ADD in one ALTER: postgres supports it, and it is atomic. */
      readonly kind: 'replaceConstraint';
      readonly table: string;
      readonly constraint: Constraint;
    }
  | { readonly kind: 'createIndex'; readonly table: string; readonly index: Index }
  | { readonly kind: 'dropIndex'; readonly index: string };

function byName<T extends { name: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map(item => [item.name, item]));
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameConstraint(a: Constraint, b: Constraint): boolean {
  if (a.type !== b.type) {return false;}

  if (a.type === 'check' && b.type === 'check') {
    return a.def.expression === b.def.expression;
  }

  if (a.type === 'foreignKey' && b.type === 'foreignKey') {
    return (
      sameArray(a.def.columns, b.def.columns) &&
      a.def.refTable === b.def.refTable &&
      sameArray(a.def.refColumns, b.def.refColumns) &&
      a.def.onDelete === b.def.onDelete &&
      a.def.onUpdate === b.def.onUpdate
    );
  }

  if (
    (a.type === 'primaryKey' || a.type === 'unique') &&
    (b.type === 'primaryKey' || b.type === 'unique')
  ) {
    return sameArray(a.def.columns, b.def.columns);
  }

  return false;
}

function sameIndex(a: Index, b: Index): boolean {
  return a.unique === b.unique && sameArray(a.columns, b.columns) && a.where === b.where;
}

function sameColumn(a: ColumnSnapshot, b: ColumnSnapshot): boolean {
  return (
    a.type === b.type &&
    a.notNull === b.notNull &&
    a.default === b.default &&
    a.identity === b.identity
  );
}

/** All constraints of a table in one list: their names share one namespace. */
function constraintsOf(table: TableSnapshot, opts: { withForeignKeys: boolean }): Constraint[] {
  const list: Constraint[] = [];

  if (table.primaryKey !== null) {
    list.push({ type: 'primaryKey', def: table.primaryKey });
  }

  for (const def of table.uniques) {
    list.push({ type: 'unique', def });
  }

  for (const def of table.checks) {
    list.push({ type: 'check', def });
  }

  if (opts.withForeignKeys) {
    for (const def of table.foreignKeys) {
      list.push({ type: 'foreignKey', def });
    }
  }

  return list;
}

export function diffSnapshots(prev: Snapshot, next: Snapshot): Change[] {
  const prevTables = byName(prev.tables);
  const nextTables = byName(next.tables);

  const dropIndexes: Change[] = [];
  const dropConstraints: Change[] = [];
  const createTables: Change[] = [];
  const addColumns: Change[] = [];
  const alterColumns: Change[] = [];
  const addConstraints: Change[] = [];
  const createIndexes: Change[] = [];
  const addForeignKeys: Change[] = [];
  const dropColumns: Change[] = [];
  const dropTables: Change[] = [];

  // ── new tables ─────────────────────────────────────────────────────────────
  for (const table of next.tables) {
    if (prevTables.has(table.name)) {
      continue;
    }

    // pk / unique / check go inside CREATE TABLE, fk and indexes separately
    createTables.push({ kind: 'createTable', table });

    for (const index of table.indexes) {
      createIndexes.push({ kind: 'createIndex', table: table.name, index });
    }

    for (const def of table.foreignKeys) {
      addForeignKeys.push({
        kind: 'addConstraint',
        table: table.name,
        constraint: { type: 'foreignKey', def },
      });
    }
  }

  // ── dropped tables ─────────────────────────────────────────────────────────
  for (const table of prev.tables) {
    if (!nextTables.has(table.name)) {
      dropTables.push({ kind: 'dropTable', table: table.name });
    }
  }

  // ── existing tables ────────────────────────────────────────────────────────
  for (const after of next.tables) {
    const before = prevTables.get(after.name);

    if (before === undefined) {
      continue;
    }

    const beforeColumns = byName(before.columns);
    const afterColumns = byName(after.columns);

    for (const column of after.columns) {
      const old = beforeColumns.get(column.name);

      if (old === undefined) {
        addColumns.push({ kind: 'addColumn', table: after.name, column });
      } else if (!sameColumn(old, column)) {
        alterColumns.push({ kind: 'alterColumn', table: after.name, from: old, to: column });
      }
    }

    for (const column of before.columns) {
      if (!afterColumns.has(column.name)) {
        dropColumns.push({ kind: 'dropColumn', table: after.name, column: column.name });
      }
    }

    const beforeConstraints = byName(
      constraintsOf(before, { withForeignKeys: true }).map(c => ({ name: c.def.name, c })),
    );
    const afterConstraints = constraintsOf(after, { withForeignKeys: true });
    const afterNames = new Set(afterConstraints.map(c => c.def.name));

    for (const constraint of afterConstraints) {
      const old = beforeConstraints.get(constraint.def.name);

      if (old === undefined) {
        const target = constraint.type === 'foreignKey' ? addForeignKeys : addConstraints;
        target.push({ kind: 'addConstraint', table: after.name, constraint });
      } else if (!sameConstraint(old.c, constraint)) {
        addConstraints.push({ kind: 'replaceConstraint', table: after.name, constraint });
      }
    }

    for (const [name] of beforeConstraints) {
      if (!afterNames.has(name)) {
        dropConstraints.push({ kind: 'dropConstraint', table: after.name, name });
      }
    }

    const beforeIndexes = byName(before.indexes);
    const afterIndexes = byName(after.indexes);

    for (const index of after.indexes) {
      const old = beforeIndexes.get(index.name);

      if (old === undefined) {
        createIndexes.push({ kind: 'createIndex', table: after.name, index });
      } else if (!sameIndex(old, index)) {
        dropIndexes.push({ kind: 'dropIndex', index: index.name });
        createIndexes.push({ kind: 'createIndex', table: after.name, index });
      }
    }

    for (const index of before.indexes) {
      if (!afterIndexes.has(index.name)) {
        dropIndexes.push({ kind: 'dropIndex', index: index.name });
      }
    }
  }

  return [
    ...dropIndexes,
    ...dropConstraints,
    ...createTables,
    ...addColumns,
    ...alterColumns,
    ...addConstraints,
    ...createIndexes,
    ...addForeignKeys,
    ...dropColumns,
    ...dropTables,
  ];
}
