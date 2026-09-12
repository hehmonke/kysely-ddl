import { type AnyColumn, args, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

interface NumericConfig {
  precision?: number;
  scale?: number;
}

/** numeric. A string in JS: no float error. */
export function numeric<N extends string>(name: N, config?: NumericConfig): Fresh<'numeric', N, string>;
export function numeric(config?: NumericConfig): Fresh<'numeric', undefined, string>;
export function numeric(a?: string | NumericConfig, b?: NumericConfig): AnyColumn {
  const { name, config } = args<NumericConfig>(a, b);
  const sqlType =
    config?.precision === undefined
      ? 'numeric'
      : config.scale === undefined
        ? `numeric(${config.precision})`
        : `numeric(${config.precision}, ${config.scale})`;

  return new ColumnBuilder(freshSpec('numeric', sqlType, name));
}
