/**
 * SQL fragments for defaults, check expressions and partial index conditions:
 * kysely's own `sql` template tag, rendered here into a plain string.
 *
 * DDL takes no bind parameters, so every `${value}` is inlined as an escaped
 * literal, and a column reference, `sql.ref('user_id')` or the `c.userId` of a
 * `defineTable` callback, renders as a quoted identifier. The rendering is done
 * by kysely's Postgres query compiler, so identifiers and strings are escaped
 * exactly the way kysely escapes them in queries, and fragments compose the
 * way they do there: a fragment inside a fragment, `sql.join`, `sql.lit`,
 * `sql.raw` all work.
 */
import {
  ColumnNode,
  createQueryId,
  createRawBuilder,
  isOperationNodeSource,
  type OperationNode,
  PostgresQueryCompiler,
  type RawBuilder,
  RawNode,
  ReferenceNode,
  sql,
} from 'kysely';

/** An SQL fragment: what `sql\`...\`` returns. */
export type Sql = RawBuilder<unknown>;

export function isSql(value: unknown): value is Sql {
  return isOperationNodeSource(value);
}

/**
 * A reference to a column by its exact database name: what the `c.column` refs
 * in a `defineTable` callback are. `sql.ref()` would parse the string instead,
 * reading `'a.b'` as table `a`, column `b`.
 */
export function columnRef(name: string): Sql {
  return createRawBuilder({
    queryId: createQueryId(),
    rawNode: RawNode.createWithChild(ReferenceNode.create(ColumnNode.create(name))),
  });
}

/** For error messages: objects as JSON, everything else as is. */
function describeValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'undefined':
      return String(value);
    case 'function':
      return 'function';
    default:
      return JSON.stringify(value);
  }
}

const INLINED = new Set(['string', 'number', 'boolean', 'bigint']);

/**
 * The Postgres compiler with one difference: `${value}` is not a bind parameter,
 * DDL has none, but an inlined, escaped literal. Only what makes sense in a
 * schema is accepted: a string, a number, a boolean, a bigint, null. Anything
 * else is a slip, a Date or a column builder interpolated by mistake; an array
 * is most likely a list that wants `inArray()` or `sql.join()`.
 */
class DdlCompiler extends PostgresQueryCompiler {
  protected override appendValue(parameter: unknown): void {
    this.appendImmediateValue(parameter);
  }

  protected override appendImmediateValue(value: unknown): void {
    if (value === null) {
      // upper case like `quoteLiteral`: a `${null}` and a plain `.default(null)` render the same
      this.append('NULL');
    } else if (INLINED.has(typeof value)) {
      super.appendImmediateValue(value);
    } else {
      const hint = Array.isArray(value) ? ', for a list use inArray() or sql.join()' : '';
      throw new Error(`cannot interpolate into sql\`\`: ${describeValue(value)}${hint}`);
    }
  }
}

/** Expands the fragment into an SQL string. */
export function renderSql(expr: Sql): string {
  return new DdlCompiler().compileQuery(expr.toOperationNode(), createQueryId()).sql;
}

/** `"status" in ('new', 'closed')`: the most common form of a check in real schemas. */
export function inArray(column: Sql, values: readonly (string | number)[]): Sql {
  return sql`${column} in (${sql.join(values)})`;
}

/**
 * Column names referenced by the expression, in order of first appearance.
 * Needed to build a check constraint name: `{table}_{columns}_check`.
 */
export function collectColumns(expr: Sql): string[] {
  const names: string[] = [];

  const walk = (node: OperationNode): void => {
    if (ReferenceNode.is(node) && ColumnNode.is(node.column)) {
      const { name } = node.column.column;

      if (!names.includes(name)) {
        names.push(name);
      }
    } else if (RawNode.is(node)) {
      node.parameters.forEach(walk);
    }
  };

  walk(expr.toOperationNode());

  return names;
}

export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(value: string | number | boolean | null): string {
  if (value === null) {
    return 'NULL';
  }

  if (typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return `'${value.replace(/'/g, "''")}'`;
}
