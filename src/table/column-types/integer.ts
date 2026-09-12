import {
  type AnyColumn,
  type BuilderFor,
  ColumnBuilder,
  type ColumnCfg,
  type Fresh,
  freshSpec,
  next,
  type Update,
} from '../columns.ts';

/** The builder of `integer()` and `bigint()`: the column types that can be identity columns. */
export class IntegerColumnBuilder<T extends ColumnCfg = ColumnCfg> extends ColumnBuilder<T> {
  /** `GENERATED ALWAYS AS IDENTITY`: postgres owns the value, it cannot be inserted. */
  generatedAlwaysAsIdentity(): BuilderFor<Update<T, { notNull: true; hasDefault: true; identity: 'always' }>> {
    return next<T, { notNull: true; hasDefault: true; identity: 'always' }>(this, {
      notNull: true,
      identity: 'always',
    });
  }
}

export function integer<N extends string>(name: N): Fresh<'integer', N, number>;
export function integer(): Fresh<'integer', undefined, number>;
export function integer(name?: string): AnyColumn {
  return new IntegerColumnBuilder(freshSpec('integer', 'integer', name));
}
