/**
 * Column builders as chains, like in drizzle.
 *
 * The set of types is what application schemas actually need:
 * uuid / varchar / integer / bigint / boolean / numeric / timestamp / jsonb,
 * plus `enum`, a varchar with an automatic check constraint.
 * Adding a type is one line at the bottom of the file.
 *
 * ── Why there is no `mode` ───────────────────────────────────────────────────
 *
 * In drizzle, `bigint({ mode: 'number' })` and `numeric({ mode: 'bigint' })` change
 * the column's TS type. But the mode describes the behaviour of drizzle's RUNTIME:
 * it converts the values itself. This library has no runtime, the driver does the
 * reading, so the column type is set once and matches what `pg` returns:
 *
 *   int8    -> string   (no precision loss beyond 2^53)
 *   numeric -> string   (no float error)
 *
 * The one option there is follows the driver instead of replacing it: `pg` and
 * `Bun.SQL` can both be told to return int8 as `bigint`, and `{ bigint: true }` in
 * the infer options (see the kysely layer) types `bigint()` columns to match.
 * For another type use `$type<T>()` plus an explicit conversion on your side.
 */
import type { Sql } from './sql.ts';

/** Column config at the type level. */
export interface ColumnCfg {
  /** The explicitly set column name; `undefined` means it is taken from the property name. */
  readonly name: string | undefined;
  readonly data: unknown;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly array: boolean;
  readonly identity: 'always' | 'byDefault' | undefined;
  /** `enum()` values: `defineTable` builds a check from them. */
  readonly enumValues: readonly string[] | undefined;
  /** A jsonb column: values for writes go through `jsonb()`, see the kysely layer. */
  readonly json: boolean;
  /**
   * An int8 column still typed as the driver's default, a string. `{ bigint: true }`
   * in the infer options reads such a column as `bigint`; `$type<T>()` clears the
   * flag, since an explicit type is final.
   */
  readonly bigint: boolean;
}

/**
 * A targeted config update: what U has overrides T, the rest is carried over.
 * `Omit<T, keyof U> & U` does not work here: TypeScript cannot prove that the
 * result is still a `ColumnCfg` when U is declared as `Partial`.
 */
type Update<T extends ColumnCfg, U extends Partial<ColumnCfg>> = {
  readonly name: U extends { name: infer V } ? V : T['name'];
  readonly data: U extends { data: infer V } ? V : T['data'];
  readonly notNull: U extends { notNull: infer V extends boolean } ? V : T['notNull'];
  readonly hasDefault: U extends { hasDefault: infer V extends boolean } ? V : T['hasDefault'];
  readonly array: U extends { array: infer V extends boolean } ? V : T['array'];
  readonly identity: U extends { identity: infer V } ? V : T['identity'];
  readonly enumValues: U extends { enumValues: infer V } ? V : T['enumValues'];
  readonly json: U extends { json: infer V extends boolean } ? V : T['json'];
  readonly bigint: U extends { bigint: infer V extends boolean } ? V : T['bigint'];
};

/** A default: a literal or an SQL expression. */
export type DefaultValue = Sql | string | number | boolean | null;

/** Everything needed to generate DDL. */
export interface ColumnSpec {
  /** The base postgres type without `[]`: 'uuid', 'varchar(2)', 'numeric(10, 2)'. */
  readonly sqlType: string;
  readonly name: string | undefined;
  readonly notNull: boolean;
  readonly default: DefaultValue | undefined;
  readonly identity: 'always' | 'byDefault' | undefined;
  readonly array: boolean;
  readonly enumValues: readonly string[] | undefined;
}

export class ColumnBuilder<T extends ColumnCfg = ColumnCfg> {
  declare readonly _: T;

  constructor(readonly spec: ColumnSpec) {}

  private next<U extends Partial<ColumnCfg>>(
    patch: Partial<ColumnSpec>,
  ): ColumnBuilder<Update<T, U>> {
    return new ColumnBuilder({ ...this.spec, ...patch });
  }

  notNull(): ColumnBuilder<Update<T, { notNull: true }>> {
    return this.next<{ notNull: true }>({ notNull: true });
  }

  default(value: DefaultValue): ColumnBuilder<Update<T, { hasDefault: true }>> {
    return this.next<{ hasDefault: true }>({ default: value });
  }

  /** Sugar for `.default(sql\`now()\`)`. */
  defaultNow(): ColumnBuilder<Update<T, { hasDefault: true }>> {
    return this.next<{ hasDefault: true }>({
      default: { kind: 'sql', chunks: ['now()'] },
    });
  }

  /** `GENERATED ALWAYS AS IDENTITY`: postgres owns the value, it cannot be inserted. */
  generatedAlwaysAsIdentity(): ColumnBuilder<
    Update<T, { notNull: true; hasDefault: true; identity: 'always' }>
  > {
    return this.next<{ notNull: true; hasDefault: true; identity: 'always' }>({
      notNull: true,
      identity: 'always',
    });
  }

  array(): ColumnBuilder<Update<T, { data: T['data'][]; array: true }>> {
    return this.next<{ data: T['data'][]; array: true }>({ array: true });
  }

  /**
   * Narrows the value type without touching the column type in the database. The
   * type is final: on a `bigint()` column it also switches the `bigint: true` infer
   * option off.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter is the whole point of the method
  $type<U>(): ColumnBuilder<Update<T, { data: U; bigint: false }>> {
    return this as unknown as ColumnBuilder<Update<T, { data: U; bigint: false }>>;
  }
}

export type AnyColumn = ColumnBuilder<ColumnCfg>;

/** A fresh column: the name is either explicit or taken from the object key. */
type Fresh<
  N extends string | undefined,
  TData,
  TEnum extends readonly string[] | undefined = undefined,
  TJson extends boolean = false,
  TBigint extends boolean = false,
> = ColumnBuilder<{
  name: N;
  data: TData;
  notNull: false;
  hasDefault: false;
  array: false;
  identity: undefined;
  enumValues: TEnum;
  json: TJson;
  bigint: TBigint;
}>;

function fresh(
  sqlType: string,
  name: string | undefined,
  enumValues?: readonly string[],
): ColumnBuilder<ColumnCfg> {
  return new ColumnBuilder({
    sqlType,
    name,
    notNull: false,
    default: undefined,
    identity: undefined,
    array: false,
    enumValues,
  });
}

/** Parses `(name?, config?)`, both forms of calling a builder. */
function args<C>(a?: string | C, b?: C): { name: string | undefined; config: C | undefined } {
  return typeof a === 'string' ? { name: a, config: b } : { name: undefined, config: a };
}

// ── column types ─────────────────────────────────────────────────────────────

function uuid<N extends string>(name: N): Fresh<N, string>;
function uuid(): Fresh<undefined, string>;
function uuid(name?: string) {
  return fresh('uuid', name);
}

interface VarcharConfig {
  length?: number;
}

function varchar<N extends string>(name: N, config?: VarcharConfig): Fresh<N, string>;
function varchar(config?: VarcharConfig): Fresh<undefined, string>;
function varchar(a?: string | VarcharConfig, b?: VarcharConfig) {
  const { name, config } = args<VarcharConfig>(a, b);
  const sqlType = config?.length === undefined ? 'varchar' : `varchar(${config.length})`;

  return fresh(sqlType, name);
}

/**
 * A set of allowed values: the column stays `varchar`, and the restriction goes
 * into a check constraint that `defineTable` builds itself:
 *
 * ```sql
 * CONSTRAINT "ticket_status_check" CHECK ("status" in ('new', 'closed'))
 * ```
 *
 * A native `create type ... as enum` is deliberately not used: adding a value
 * requires `ALTER TYPE`, and the new value cannot be used in the same transaction
 * that added it. `varchar` + check changes with a regular `ALTER TABLE`.
 *
 * In the types this is a union of string literals, not `string`.
 *
 * The function is declared as `enumColumn` because `enum` is a reserved word and
 * cannot name a declaration. It can be an object key though, and the builders are
 * handed out only as an object, so from the outside it is exactly `t.enum(...)`.
 */
function enumColumn<N extends string, const T extends readonly [string, ...string[]]>(
  name: N,
  values: T,
): Fresh<N, T[number], T>;
function enumColumn<const T extends readonly [string, ...string[]]>(
  values: T,
): Fresh<undefined, T[number], T>;
function enumColumn(
  a: string | readonly [string, ...string[]],
  b?: readonly [string, ...string[]],
) {
  const name = typeof a === 'string' ? a : undefined;
  const values = typeof a === 'string' ? b : a;

  if (values === undefined || values.length === 0) {
    throw new Error('enum(): a non-empty list of values is required');
  }

  return fresh('varchar', name, values);
}

function integer<N extends string>(name: N): Fresh<N, number>;
function integer(): Fresh<undefined, number>;
function integer(name?: string) {
  return fresh('integer', name);
}

/**
 * int8. A string in JS by default: that is what `pg` and `Bun.SQL` return, and no
 * precision is lost. A driver told to return `bigint` is matched by the
 * `bigint: true` infer option, which turns these columns into `bigint`.
 */
function bigint<N extends string>(name: N): Fresh<N, string, undefined, false, true>;
function bigint(): Fresh<undefined, string, undefined, false, true>;
function bigint(name?: string) {
  return fresh('bigint', name);
}

function boolean<N extends string>(name: N): Fresh<N, boolean>;
function boolean(): Fresh<undefined, boolean>;
function boolean(name?: string) {
  return fresh('boolean', name);
}

interface NumericConfig {
  precision?: number;
  scale?: number;
}

/** numeric. A string in JS: no float error. */
function numeric<N extends string>(name: N, config?: NumericConfig): Fresh<N, string>;
function numeric(config?: NumericConfig): Fresh<undefined, string>;
function numeric(a?: string | NumericConfig, b?: NumericConfig) {
  const { name, config } = args<NumericConfig>(a, b);
  const sqlType =
    config?.precision === undefined
      ? 'numeric'
      : config.scale === undefined
        ? `numeric(${config.precision})`
        : `numeric(${config.precision}, ${config.scale})`;

  return fresh(sqlType, name);
}

interface TimestampConfig {
  withTimezone?: boolean;
  precision?: number;
}

function timestamp<N extends string>(name: N, config?: TimestampConfig): Fresh<N, Date>;
function timestamp(config?: TimestampConfig): Fresh<undefined, Date>;
function timestamp(a?: string | TimestampConfig, b?: TimestampConfig) {
  const { name, config } = args<TimestampConfig>(a, b);
  const precision = config?.precision === undefined ? '' : `(${config.precision})`;
  const tz = config?.withTimezone === true ? ' with time zone' : '';

  return fresh(`timestamp${precision}${tz}`, name);
}

/**
 * `unknown` in TS, narrow it with `$type<T>()`. Values for writes go only
 * through `jsonb()` from `kysely-ddl`: drivers accept a raw jsonb
 * parameter differently, and the helper evens that out.
 */
function jsonb<N extends string>(name: N): Fresh<N, unknown, undefined, true>;
function jsonb(): Fresh<undefined, unknown, undefined, true>;
function jsonb(name?: string) {
  return fresh('jsonb', name);
}

// ── the builder set for the callback form ────────────────────────────────────

/**
 * What arrives in `columns: t => ({ ... })`.
 *
 * Builders are not exported one by one: the only way to declare a column is the
 * callback. So the schema file has no import list to maintain with every new
 * column, and there is exactly one declaration form.
 */
const columnBuilders = {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  timestamp,
  enum: enumColumn,
  uuid,
  varchar,
} as const;

export { columnBuilders };
export type ColumnBuilders = typeof columnBuilders;
