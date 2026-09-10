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
 * When Kysely runs with `CamelCasePlugin`, pass `true` as the second parameter:
 * the column and table keys then become camelCase versions of the database names,
 * exactly as the plugin rewrites them with default options:
 *
 * ```ts
 * type DB = inferKyselyDatabase<typeof schema, true>;
 * const db = new Kysely<DB>({ dialect, plugins: [new CamelCasePlugin()] });
 * ```
 *
 * `kysely` is imported as a type only; there is no runtime dependency.
 */
import type { CamelCase } from '../table/casing.ts';
import type { ResolvedColumnCfg, Table } from '../table/define.ts';

import type { Jsonb } from './json.ts';

import type { ColumnType } from 'kysely';

type Cols<T extends Table> = T['_']['columns'];

/** The key in the Kysely interface: the database name or, under `CamelCasePlugin`, its camelCase. */
type Key<Name extends string, Camel extends boolean> = Camel extends true ? CamelCase<Name> : Name;

/** What comes back from SELECT. */
type Select<C extends ResolvedColumnCfg> = C['notNull'] extends true ? C['data'] : C['data'] | null;

type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

/**
 * What goes into INSERT / UPDATE before nullability and defaults are applied. For
 * jsonb this is branded JSON text: only `jsonb()` produces it (`jsonbArray()` for
 * `jsonb[]`), a raw object or string does not compile.
 */
type Written<C extends ResolvedColumnCfg> = C['json'] extends true
  ? C['array'] extends true
    ? Jsonb<ElementOf<C['data']>>[]
    : Jsonb<C['data']>
  : C['data'];

/**
 * What can be passed for a write:
 *   identity always          -> not at all;
 *   notNull without default  -> required field;
 *   has a default            -> optional;
 *   nullable                 -> optional and accepts null.
 */
type Insert<C extends ResolvedColumnCfg> = C['identity'] extends 'always'
  ? never
  : C['notNull'] extends true
    ? C['hasDefault'] extends true
      ? Written<C> | undefined
      : Written<C>
    : Written<C> | null | undefined;

export type inferKyselyTable<T extends Table, Camel extends boolean = false> = {
  [K in keyof Cols<T> as Key<Cols<T>[K]['name'], Camel>]: ColumnType<
    Select<Cols<T>[K]>,
    Insert<Cols<T>[K]>,
    Insert<Cols<T>[K]>
  >;
};

/**
 * The interface of the whole database from a schema module: the key is the table
 * name, the value is `inferKyselyTable`. Anything that is not a table (constants,
 * types, zod schemas) is filtered out.
 */
export type inferKyselyDatabase<TSchema, Camel extends boolean = false> = {
  [K in keyof TSchema as TSchema[K] extends Table ? Key<TSchema[K]['_']['name'], Camel> : never]: TSchema[K] extends Table
    ? inferKyselyTable<TSchema[K], Camel>
    : never;
};
