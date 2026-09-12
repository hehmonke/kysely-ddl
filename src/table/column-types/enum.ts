import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

/**
 * The type-level check on the values of `enum()`, intersected with the parameter
 * so that `T` is still inferred from the argument. A list that passes adds
 * `unknown`, which changes nothing; one that fails requires a property named
 * after the reason, and that name is what the compiler error shows.
 *
 * A `string[]` carries no literals: the column would be typed `string`, which is
 * what `enum()` exists to avoid. An empty list is refused here for a literal
 * `[]`; the runtime check in `enumColumn` covers callers without types.
 */
type EnumValues<T extends readonly string[]> = string extends T[number]
  ? { readonly 'enum(): the values must be string literals, not string[]': true }
  : T extends readonly []
    ? { readonly 'enum(): a non-empty list of values is required': true }
    : unknown;

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
 * In the types this is a union of string literals, not `string`. The list is any
 * array typed as such literals, not only one written in place, so it can be shared
 * with the validation layer: Zod's `.options`, `Object.values()` of a string enum,
 * a `const` array. `EnumValues` refuses a `string[]` and an empty list.
 *
 * The function is declared as `enumColumn` because `enum` is a reserved word and
 * cannot name a declaration. It can be an object key though, and the builders are
 * handed out only as an object, so from the outside it is exactly `t.enum(...)`.
 */
export function enumColumn<N extends string, const T extends readonly string[]>(
  name: N,
  values: T & EnumValues<T>,
): Fresh<'varchar', N, T[number], T>;
export function enumColumn<const T extends readonly string[]>(
  values: T & EnumValues<T>,
): Fresh<'varchar', undefined, T[number], T>;
export function enumColumn(a: string | readonly string[], b?: readonly string[]): AnyColumn {
  const name = typeof a === 'string' ? a : undefined;
  const values = typeof a === 'string' ? b : a;

  if (values === undefined || values.length === 0) {
    throw new Error('enum(): a non-empty list of values is required');
  }

  return new ColumnBuilder(freshSpec('varchar', 'varchar', name, values));
}
