import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

export function uuid<N extends string>(name: N): Fresh<'uuid', N, string>;
export function uuid(): Fresh<'uuid', undefined, string>;
export function uuid(name?: string): AnyColumn {
  return new ColumnBuilder(freshSpec('uuid', 'uuid', name));
}
