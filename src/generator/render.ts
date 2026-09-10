/**
 * Changes -> SQL. Decides nothing, only prints: all decisions are made in diff.ts.
 */
import { quoteIdentifier as q } from '../table/sql.ts';

import type { Change, Constraint } from './diff.ts';
import type { ColumnSnapshot, TableSnapshot } from './snapshot.ts';

/** Every variant is handled above; TypeScript does not let control get here. */
function unreachable(value: never): never {
  throw new Error(`unknown variant: ${JSON.stringify(value)}`);
}

function columns(names: readonly string[]): string {
  return names.map(q).join(',');
}

function columnLine(column: ColumnSnapshot): string {
  const parts = [q(column.name), column.type];

  if (column.default !== null) {
    parts.push(`DEFAULT ${column.default}`);
  }

  if (column.identity !== null) {
    parts.push(`GENERATED ${column.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
  }

  if (column.notNull) {
    parts.push('NOT NULL');
  }

  return parts.join(' ');
}

/** Constraint body without the CONSTRAINT keyword and the name. */
function constraintBody(constraint: Constraint): string {
  switch (constraint.type) {
    case 'primaryKey':
      return `PRIMARY KEY(${columns(constraint.def.columns)})`;
    case 'unique':
      return `UNIQUE(${columns(constraint.def.columns)})`;
    case 'check':
      return `CHECK (${constraint.def.expression})`;
    case 'foreignKey': {
      const { def } = constraint;
      const parts = [
        `FOREIGN KEY (${columns(def.columns)})`,
        `REFERENCES ${q(def.refTable)}(${columns(def.refColumns)})`,
      ];

      if (def.onDelete !== null) {
        parts.push(`ON DELETE ${def.onDelete.toUpperCase()}`);
      }

      if (def.onUpdate !== null) {
        parts.push(`ON UPDATE ${def.onUpdate.toUpperCase()}`);
      }

      return parts.join(' ');
    }
    default:
      return unreachable(constraint);
  }
}

function constraintClause(constraint: Constraint): string {
  return `CONSTRAINT ${q(constraint.def.name)} ${constraintBody(constraint)}`;
}

function createTable(table: TableSnapshot): string {
  const lines = table.columns.map(columnLine);

  if (table.primaryKey !== null) {
    lines.push(constraintClause({ type: 'primaryKey', def: table.primaryKey }));
  }

  for (const def of table.uniques) {
    lines.push(constraintClause({ type: 'unique', def }));
  }

  for (const def of table.checks) {
    lines.push(constraintClause({ type: 'check', def }));
  }

  return `CREATE TABLE ${q(table.name)} (\n${lines.map(l => `\t${l}`).join(',\n')}\n);`;
}

function createIndex(table: string, index: TableSnapshot['indexes'][number]): string {
  const unique = index.unique ? 'UNIQUE ' : '';
  const where = index.where === null ? '' : ` WHERE ${index.where}`;

  return `CREATE ${unique}INDEX ${q(index.name)} ON ${q(table)} (${columns(index.columns)})${where};`;
}

function alterColumn(table: string, from: ColumnSnapshot, to: ColumnSnapshot): string[] {
  const head = `ALTER TABLE ${q(table)} ALTER COLUMN ${q(to.name)}`;
  const out: string[] = [];

  if (from.type !== to.type) {
    out.push(`${head} TYPE ${to.type};`);
  }

  if (from.default !== to.default) {
    out.push(to.default === null ? `${head} DROP DEFAULT;` : `${head} SET DEFAULT ${to.default};`);
  }

  if (from.notNull !== to.notNull) {
    out.push(to.notNull ? `${head} SET NOT NULL;` : `${head} DROP NOT NULL;`);
  }

  if (from.identity !== to.identity) {
    out.push(
      to.identity === null
        ? `${head} DROP IDENTITY;`
        : `${head} ADD GENERATED ${to.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY;`,
    );
  }

  return out;
}

export function renderChange(change: Change): string[] {
  switch (change.kind) {
    case 'createTable':
      return [createTable(change.table)];

    case 'dropTable':
      return [`DROP TABLE ${q(change.table)};`];

    case 'addColumn':
      return [`ALTER TABLE ${q(change.table)} ADD COLUMN ${columnLine(change.column)};`];

    case 'dropColumn':
      return [`ALTER TABLE ${q(change.table)} DROP COLUMN ${q(change.column)};`];

    case 'alterColumn':
      return alterColumn(change.table, change.from, change.to);

    case 'addConstraint':
      return [`ALTER TABLE ${q(change.table)} ADD ${constraintClause(change.constraint)};`];

    case 'dropConstraint':
      return [`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${q(change.name)};`];

    case 'replaceConstraint':
      return [
        `ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${q(change.constraint.def.name)}, ` +
          `ADD ${constraintClause(change.constraint)};`,
      ];

    case 'createIndex':
      return [createIndex(change.table, change.index)];

    case 'dropIndex':
      return [`DROP INDEX ${q(change.index)};`];
    default:
      return unreachable(change);
  }
}

/** Individual statements; `writeMigration` writes these to disk. */
export function renderStatements(changes: readonly Change[]): string[] {
  return changes.flatMap(renderChange);
}

/** Multi-line statements are separated by a blank line, single-line ones follow each other. */
export function renderChanges(changes: readonly Change[]): string {
  const statements = renderStatements(changes);
  let out = '';

  statements.forEach((statement, i) => {
    if (i > 0) {
      const previous = statements[i - 1] ?? '';
      out += previous.includes('\n') || statement.includes('\n') ? '\n\n' : '\n';
    }
    out += statement;
  });

  return out === '' ? '' : `${out}\n`;
}
