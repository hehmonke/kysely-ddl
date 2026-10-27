import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

/** float8. A number in JS, with float rounding: for money use `numeric()`. */
export function doublePrecision<N extends string>(name: N): Fresh<'doublePrecision', N, number>;
export function doublePrecision(): Fresh<'doublePrecision', undefined, number>;
export function doublePrecision(name?: string): AnyColumn {
  return new ColumnBuilder(freshSpec('doublePrecision', 'double precision', name));
}
