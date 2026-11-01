import { type AnyColumn, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

/**
 * date: a calendar day without a time. `Date` in TypeScript, because that is what
 * `pg` and `Bun.SQL` both return, though not the same midnight: `Bun.SQL` gives
 * midnight UTC, `pg` midnight in the process time zone. The README has the table.
 */
export function date<N extends string>(name: N): Fresh<'date', N, Date>;
export function date(): Fresh<'date', undefined, Date>;
export function date(name?: string): AnyColumn {
  return new ColumnBuilder(freshSpec('date', 'date', name));
}
