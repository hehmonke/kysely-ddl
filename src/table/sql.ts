/**
 * A minimal SQL fragment: everything needed for defaults, check expressions
 * and partial index conditions.
 *
 * The fragment is stored as chunks rather than a string, so that a column
 * reference can be rendered with its DATABASE NAME (`"user_id"`) instead of
 * the property name.
 */

/** A column reference inside an expression. */
export interface ColumnRef {
  readonly kind: 'column';
  /** The column name in the database. */
  readonly name: string;
}

/** A literal that must be escaped when rendered. */
export interface Literal {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
}

export type SqlChunk = string | ColumnRef | Literal;

export interface Sql {
  readonly kind: 'sql';
  readonly chunks: readonly SqlChunk[];
}

export function isSql(value: unknown): value is Sql {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'sql';
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

function toChunk(value: unknown): SqlChunk {
  if (isSql(value)) {
    // nested fragments would be expanded on render; a marker is enough here
    throw new Error('nested sql`` is not supported: build the expression as a single template');
  }

  if (typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'column') {
    return value as ColumnRef;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return { kind: 'literal', value };
  }

  throw new Error(`cannot interpolate into sql\`\`: ${describeValue(value)}`);
}

/**
 * ```ts
 * sql`${c.delta} <> 0`
 * sql`uuidv7()`
 * ```
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  const chunks: SqlChunk[] = [];

  strings.forEach((part, i) => {
    if (part) {
      chunks.push(part);
    }

    if (i < values.length) {
      chunks.push(toChunk(values[i]));
    }
  });

  return { kind: 'sql', chunks };
}

/** `"status" in ('new', 'closed')`: the most common form of a check in real schemas. */
export function inArray(column: ColumnRef, values: readonly (string | number)[]): Sql {
  const chunks: SqlChunk[] = [column, ' in ('];

  values.forEach((value, i) => {
    if (i > 0) {
      chunks.push(', ');
    }
    chunks.push({ kind: 'literal', value });
  });

  chunks.push(')');

  return { kind: 'sql', chunks };
}

/**
 * Column names referenced by the expression, in order of first appearance.
 * Needed to build a check constraint name: `{table}_{columns}_check`.
 */
export function collectColumns(expr: Sql): string[] {
  const names: string[] = [];

  for (const chunk of expr.chunks) {
    if (typeof chunk !== 'string' && chunk.kind === 'column' && !names.includes(chunk.name)) {
      names.push(chunk.name);
    }
  }

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

/** Expands the fragment into an SQL string. */
export function renderSql(expr: Sql): string {
  return expr.chunks
    .map(chunk => {
      if (typeof chunk === 'string') {
        return chunk;
      }

      if (chunk.kind === 'column') {
        return quoteIdentifier(chunk.name);
      }

      return quoteLiteral(chunk.value);
    })
    .join('');
}
