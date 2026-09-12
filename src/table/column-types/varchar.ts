import { type AnyColumn, args, ColumnBuilder, type Fresh, freshSpec } from '../columns.ts';

interface VarcharConfig {
  length?: number;
}

export function varchar<N extends string>(name: N, config?: VarcharConfig): Fresh<'varchar', N, string>;
export function varchar(config?: VarcharConfig): Fresh<'varchar', undefined, string>;
export function varchar(a?: string | VarcharConfig, b?: VarcharConfig): AnyColumn {
  const { name, config } = args<VarcharConfig>(a, b);
  const sqlType = config?.length === undefined ? 'varchar' : `varchar(${config.length})`;

  return new ColumnBuilder(freshSpec('varchar', sqlType, name));
}
