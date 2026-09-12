import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

/**
 * A set of allowed values: the column stays `varchar`, and the restriction goes
 * into a check constraint that `defineTable` builds itself:
 *
 * ```sql
 * CONSTRAINT "ticket_status_check" CHECK ("status" in ('new', 'closed'))
 * ```
 *
 * A native `create type ... as enum` is deliberately not used: adding a value
 * requires `ALTER TYPE`, and the new value cannot be used in the same transaction
 * that added it. `varchar` + check changes with a regular `ALTER TABLE`.
 *
 * In the types this is a union of string literals, not `string`.
 *
 * The function is declared as `enumColumn` because `enum` is a reserved word and
 * cannot name a declaration. It can be an object key though, and the builders are
 * handed out only as an object, so from the outside it is exactly `t.enum(...)`.
 */
export function enumColumn<N extends string, const T extends readonly [string, ...string[]]>(
  name: N,
  values: T,
): Fresh<'varchar', N, T[number], T>;
export function enumColumn<const T extends readonly [string, ...string[]]>(
  values: T,
): Fresh<'varchar', undefined, T[number], T>;
export function enumColumn(
  a: string | readonly [string, ...string[]],
  b?: readonly [string, ...string[]],
): AnyColumn {
  const name = typeof a === 'string' ? a : undefined;
  const values = typeof a === 'string' ? b : a;

  if (values === undefined || values.length === 0) {
    throw new Error('enum(): a non-empty list of values is required');
  }

  return new ColumnBuilder(freshSpec('varchar', 'varchar', name, values));
}
