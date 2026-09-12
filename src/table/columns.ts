/**
 * Column builders as chains, like in drizzle.
 *
 * The set of types is what application schemas actually need:
 * uuid / varchar / integer / bigint / boolean / numeric / timestamp / jsonb,
 * plus `enum`, a varchar with an automatic check constraint. Each type is a file
 * in `column-types/`; adding a type is a new file there plus a line in
 * `columnBuilders`.
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
 *
 * ── One builder per column type ──────────────────────────────────────────────
 *
 * The shared modifiers, `notNull()`, `default()`, `array()`, `$type()`, live on
 * `ColumnBuilder` here. A modifier that applies to some types only lives on a
 * subclass in the type's file: `defaultNow()` on the timestamp builder,
 * `generatedAlwaysAsIdentity()` on the integer one, so each is offered exactly
 * where it makes sense. A chain keeps its builder: `BuilderFor` picks the class
 * from the column kind at the type level, `next()` at runtime. An array column is
 * a plain column, since neither of those modifiers applies to an array.
 */
import type { IntegerColumnBuilder } from './column-types/integer.ts';
import type { TimestampColumnBuilder } from './column-types/timestamp.ts';
import type { Sql } from './sql.ts';

/** The base postgres type of a column; `enum()` is a varchar. */
export type ColumnKind = 'uuid' | 'varchar' | 'integer' | 'bigint' | 'boolean' | 'numeric' | 'timestamp' | 'jsonb';

/** Column config at the type level. */
export interface ColumnCfg {
  readonly kind: ColumnKind;
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
export type Update<T extends ColumnCfg, U extends Partial<ColumnCfg>> = {
  readonly kind: U extends { kind: infer V extends ColumnKind } ? V : T['kind'];
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
  readonly kind: ColumnKind;
  /** The base postgres type without `[]`: 'uuid', 'varchar(2)', 'numeric(10, 2)'. */
  readonly sqlType: string;
  readonly name: string | undefined;
  readonly notNull: boolean;
  readonly default: DefaultValue | undefined;
  readonly identity: 'always' | 'byDefault' | undefined;
  readonly array: boolean;
  readonly enumValues: readonly string[] | undefined;
}

/**
 * The builder for a config: the subclass of the column's kind, or the plain
 * builder for an array column. A new subclass in `column-types/` gets a line here.
 */
export type BuilderFor<T extends ColumnCfg> = T['array'] extends true
  ? ColumnBuilder<T>
  : T['kind'] extends 'timestamp'
    ? TimestampColumnBuilder<T>
    : T['kind'] extends 'integer' | 'bigint'
      ? IntegerColumnBuilder<T>
      : ColumnBuilder<T>;

/** The modifiers every column has. The type-specific ones are on the subclasses in `column-types/`. */
export class ColumnBuilder<T extends ColumnCfg = ColumnCfg> {
  declare readonly _: T;

  constructor(readonly spec: ColumnSpec) {}

  notNull(): BuilderFor<Update<T, { notNull: true }>> {
    return next<T, { notNull: true }>(this, { notNull: true });
  }

  default(value: DefaultValue): BuilderFor<Update<T, { hasDefault: true }>> {
    return next<T, { hasDefault: true }>(this, { default: value });
  }

  /** An array column is a plain column: `defaultNow()` and identity do not apply to arrays. */
  array(): ColumnBuilder<Update<T, { data: T['data'][]; array: true }>> {
    return new ColumnBuilder<Update<T, { data: T['data'][]; array: true }>>({ ...this.spec, array: true });
  }

  /**
   * Narrows the value type without touching the column type in the database. The
   * type is final: on a `bigint()` column it also switches the `bigint: true` infer
   * option off.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the type parameter is the whole point of the method
  $type<U>(): BuilderFor<Update<T, { data: U; bigint: false }>> {
    return this as unknown as BuilderFor<Update<T, { data: U; bigint: false }>>;
  }
}

/**
 * What `defineTable` needs from a column: the config type and the spec. Not the
 * builder class itself, so that TypeScript never compares two builders of
 * different configs member by member.
 */
export interface AnyColumn {
  readonly _: ColumnCfg;
  readonly spec: ColumnSpec;
}

/** A fresh column of a kind: the name is either explicit or taken from the object key. */
export type Fresh<
  K extends ColumnKind,
  N extends string | undefined,
  TData,
  TEnum extends readonly string[] | undefined = undefined,
  TJson extends boolean = false,
  TBigint extends boolean = false,
> = BuilderFor<{
  kind: K;
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

/** The spec of a fresh column, for the factories in `column-types/`. */
export function freshSpec(
  kind: ColumnKind,
  sqlType: string,
  name: string | undefined,
  enumValues?: readonly string[],
): ColumnSpec {
  return { kind, sqlType, name, notNull: false, default: undefined, identity: undefined, array: false, enumValues };
}

/**
 * A copy of the builder with the patch applied, of the same class, so that a
 * chain keeps the modifiers of its type; the config type is updated the same way.
 */
export function next<T extends ColumnCfg, U extends Partial<ColumnCfg>>(
  builder: ColumnBuilder<T>,
  patch: Partial<ColumnSpec>,
): BuilderFor<Update<T, U>> {
  const Self = builder.constructor as new (spec: ColumnSpec) => BuilderFor<Update<T, U>>;

  return new Self({ ...builder.spec, ...patch });
}

/** Parses `(name?, config?)`, both forms of calling a builder. */
export function args<C>(a?: string | C, b?: C): { name: string | undefined; config: C | undefined } {
  return typeof a === 'string' ? { name: a, config: b } : { name: undefined, config: a };
}
