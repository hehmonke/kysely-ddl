import { type AnyColumn, type Fresh, freshSpec } from '../columns.ts';

import { IntegerColumnBuilder } from './integer.ts';

/**
 * int8. A string in JS by default: that is what `pg` and `Bun.SQL` return, and no
 * precision is lost. A driver told to return `bigint` is matched by the
 * `bigint: true` infer option, which turns these columns into `bigint`.
 */
export function bigint<N extends string>(name: N): Fresh<'bigint', N, string, undefined, false, true>;
export function bigint(): Fresh<'bigint', undefined, string, undefined, false, true>;
export function bigint(name?: string): AnyColumn {
  return new IntegerColumnBuilder(freshSpec('bigint', 'bigint', name));
}
