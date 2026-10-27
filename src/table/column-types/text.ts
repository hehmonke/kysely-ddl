import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

/** text: the same storage as `varchar()` without a length, a different type name in the database. */
export function text<N extends string>(name: N): Fresh<'text', N, string>;
export function text(): Fresh<'text', undefined, string>;
export function text(name?: string): AnyColumn {
  return new ColumnBuilder(freshSpec('text', 'text', name));
}
