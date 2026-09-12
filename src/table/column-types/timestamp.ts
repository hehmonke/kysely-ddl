import { sql } from 'kysely';

import {
  type AnyColumn,
  args,
  type BuilderFor,
  ColumnBuilder,
  type ColumnCfg,
  type Fresh,
  freshSpec,
  next,
  type Update,
} from '../columns.ts';

/** The builder of `timestamp()`: the one column type with a `now()` default worth a shorthand. */
export class TimestampColumnBuilder<T extends ColumnCfg = ColumnCfg> extends ColumnBuilder<T> {
  /** Sugar for `.default(sql\`now()\`)`. */
  defaultNow(): BuilderFor<Update<T, { hasDefault: true }>> {
    return next<T, { hasDefault: true }>(this, { default: sql`now()` });
  }
}

interface TimestampConfig {
  withTimezone?: boolean;
  precision?: number;
}

export function timestamp<N extends string>(name: N, config?: TimestampConfig): Fresh<'timestamp', N, Date>;
export function timestamp(config?: TimestampConfig): Fresh<'timestamp', undefined, Date>;
export function timestamp(a?: string | TimestampConfig, b?: TimestampConfig): AnyColumn {
  const { name, config } = args<TimestampConfig>(a, b);
  const precision = config?.precision === undefined ? '' : `(${config.precision})`;
  const tz = config?.withTimezone === true ? ' with time zone' : '';

  return new TimestampColumnBuilder(freshSpec('timestamp', `timestamp${precision}${tz}`, name));
}
