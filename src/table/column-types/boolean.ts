import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

export function boolean<N extends string>(name: N): Fresh<'boolean', N, boolean>;
export function boolean(): Fresh<'boolean', undefined, boolean>;
export function boolean(name?: string): AnyColumn {
  return new ColumnBuilder(freshSpec('boolean', 'boolean', name));
}
