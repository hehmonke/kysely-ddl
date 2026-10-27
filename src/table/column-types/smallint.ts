import { type AnyColumn, type Fresh, freshSpec } from '../columns.ts';

import { IntegerColumnBuilder } from './integer.ts';

/** int2. A number in JS: that is what `pg` and `Bun.SQL` return. */
export function smallint<N extends string>(name: N): Fresh<'smallint', N, number>;
export function smallint(): Fresh<'smallint', undefined, number>;
export function smallint(name?: string): AnyColumn {
  return new IntegerColumnBuilder(freshSpec('smallint', 'smallint', name));
}
