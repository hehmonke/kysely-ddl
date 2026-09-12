import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

/**
 * `unknown` in TS, narrow it with `$type<T>()`. Values for writes go only
 * through `jsonb()` from `kysely-ddl`: drivers accept a raw jsonb
 * parameter differently, and the helper evens that out.
 */
export function jsonb<N extends string>(name: N): Fresh<'jsonb', N, unknown, undefined, true>;
export function jsonb(): Fresh<'jsonb', undefined, unknown, undefined, true>;
export function jsonb(name?: string): AnyColumn {
  return new ColumnBuilder(freshSpec('jsonb', 'jsonb', name));
}
