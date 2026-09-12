/**
 * Table types for Kysely, like zod's `z.infer`:
 *
 * ```ts
 * type UserTable = inferKyselyTable<typeof userTable>;
 * type DB = inferKyselyDatabase<typeof schema>;
 *
 * const db = new Kysely<DB>({ dialect });
 * ```
 *
 * Keys are the COLUMN NAMES IN THE DATABASE. They are known at the type level
 * because `defineTable` keeps them as literals, so the bridge does not depend on
 * casing plugins or on conventions shared between two libraries.
 *
 * The second parameter is an options object, `InferOptions`, and the options combine:
 *
 * ```ts
 * // Kysely runs with CamelCasePlugin: column and table keys become camelCase,
 * // exactly as the plugin rewrites them with default options
 * type DB = inferKyselyDatabase<typeof schema, { camelCase: true }>;
 * const db = new Kysely<DB>({ dialect, plugins: [new CamelCasePlugin()] });
 *
 * // the driver returns int8 as BigInt (Bun.SQL with `{ bigint: true }`, pg with a
 * // type parser): bigint() columns become bigint, bigint().array() ones bigint[]
 * type DB = inferKyselyDatabase<typeof schema, { bigint: true }>;
 * ```
 *
 * `kysely` is imported as a type only; there is no runtime dependency.
 */
import type { CamelCase } from '../table/casing.ts';
import type { ResolvedColumnCfg, Table } from '../table/define.ts';

import type { Jsonb } from './json.ts';

import type { ColumnType } from 'kysely';

/** The second parameter of `inferKyselyTable` and `inferKyselyDatabase`. Everything is off by default. */
export interface InferOptions {
  /**
   * Column and table keys as `CamelCasePlugin` rewrites them: `created_at` ->
   * `createdAt`, `audit_log` -> `auditLog`. Otherwise the names in the database.
   */
  readonly camelCase?: boolean;
  /**
   * `bigint()` columns as `bigint` and `bigint().array()` columns as `bigint[]`,
   * for a driver that returns int8 that way: `Bun.SQL` with `{ bigint: true }`,
   * `pg` with a type parser for oid 20 (and 1016 for arrays). Otherwise strings,
   * which is what both drivers return by default. A column with `$type<T>()`
   * stays `T` either way.
   */
  readonly bigint?: boolean;
}

type Camel<O extends InferOptions> = O extends { readonly camelCase: true } ? true : false;
type Big<O extends InferOptions> = O extends { readonly bigint: true } ? true : false;

type Cols<T extends Table> = T['_']['columns'];

/** The key in the Kysely interface: the database name or, under `CamelCasePlugin`, its camelCase. */
type Key<Name extends string, O extends InferOptions> = Camel<O> extends true ? CamelCase<Name> : Name;

/** The JS value of a column: `data` from the builder, or `bigint` for an int8 the driver returns that way. */
type Data<C extends ResolvedColumnCfg, O extends InferOptions> = C['bigint'] extends true
  ? Big<O> extends true
    ? C['array'] extends true
      ? bigint[]
      : bigint
    : C['data']
  : C['data'];

/** What comes back from SELECT. */
type Select<C extends ResolvedColumnCfg, O extends InferOptions> = C['notNull'] extends true
  ? Data<C, O>
  : Data<C, O> | null;

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

/**
 * What goes into INSERT / UPDATE before nullability and defaults are applied. For
 * jsonb this is branded JSON text: only `jsonb()` produces it (`jsonbArray()` for
 * `jsonb[]`), a raw object or string does not compile.
 */
type Written<C extends ResolvedColumnCfg, O extends InferOptions> = C['json'] extends true
  ? C['array'] extends true
    ? Jsonb<ElementOf<C['data']>>[]
    : Jsonb<C['data']>
  : Data<C, O>;

/**
 * What can be passed for a write:
 *   identity always          -> not at all;
 *   notNull without default  -> required field;
 *   has a default            -> optional;
 *   nullable                 -> optional and accepts null.
 */
type Insert<C extends ResolvedColumnCfg, O extends InferOptions> = C['identity'] extends 'always'
  ? never
  : C['notNull'] extends true
    ? C['hasDefault'] extends true
      ? Written<C, O> | undefined
      : Written<C, O>
    : Written<C, O> | null | undefined;

export type inferKyselyTable<T extends Table, O extends InferOptions = InferOptions> = {
  [K in keyof Cols<T> as Key<Cols<T>[K]['name'], O>]: ColumnType<
    Select<Cols<T>[K], O>,
    Insert<Cols<T>[K], O>,
    Insert<Cols<T>[K], O>
  >;
};

/**
 * The interface of the whole database from a schema module: the key is the table
 * name, the value is `inferKyselyTable`. Anything that is not a table (constants,
 * types, zod schemas) is filtered out.
 */
export type inferKyselyDatabase<TSchema, O extends InferOptions = InferOptions> = {
  [K in keyof TSchema as TSchema[K] extends Table ? Key<TSchema[K]['_']['name'], O> : never]: TSchema[K] extends Table
    ? inferKyselyTable<TSchema[K], O>
    : never;
};
