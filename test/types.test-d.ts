import { type CamelCase, defineTable, ref, type SnakeCase, sql } from '../src/index.ts';
import { type inferKyselyDatabase, type inferKyselyTable, type Jsonb, jsonb, jsonbArray } from '../src/kysely/index.ts';

/**
 * Type-level checks. The file is never executed, only `tsc` reads it
 * (`bun run typecheck`); a failing `Expect` is a compile error.
 */
import type { Insertable, InsertObject, Selectable, UpdateObject } from 'kysely';

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the standard trick for comparing types
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

type UUID = string & { readonly __brand: 'uuid' };

const userTable = defineTable({
  tableName: 'user',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`).$type<UUID>(),
    createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    nickname: t.varchar().notNull(),
    email: t.varchar(),
    status: t.enum(['active', 'banned']).notNull(),
    legacy: t.integer('legacy_id').generatedAlwaysAsIdentity(),
    tags: t.varchar().array().notNull(),
    balance: t.numeric({ precision: 10, scale: 2 }).notNull().default('0'),
  }),
  primaryKey: { columns: ['id'] },
});

const schema = { userTable, NOT_A_TABLE: 42, helper: () => 1 };

type UserTable = inferKyselyTable<typeof userTable>;
type DB = inferKyselyDatabase<typeof schema>;

export type Tests = [
  // the table name and column names are literals derived from properties
  Expect<Equal<(typeof userTable)['_']['name'], 'user'>>,
  Expect<Equal<(typeof userTable)['_']['columns']['createdAt']['name'], 'created_at'>>,
  Expect<Equal<(typeof userTable)['_']['columns']['legacy']['name'], 'legacy_id'>>,
  Expect<Equal<keyof UserTable, 'id' | 'created_at' | 'nickname' | 'email' | 'status' | 'legacy_id' | 'tags' | 'balance'>>,

  // what comes back from SELECT
  Expect<
    Equal<
      Simplify<Selectable<UserTable>>,
      {
        id: UUID;
        created_at: Date;
        nickname: string;
        email: string | null;
        status: 'active' | 'banned';
        legacy_id: number;
        tags: string[];
        balance: string;
      }
    >
  >,

  // what can be inserted: default is optional, nullable is optional and null, identity always has no key
  Expect<
    Equal<
      Simplify<Insertable<UserTable>>,
      {
        id?: UUID;
        created_at?: Date;
        nickname: string;
        email?: string | null;
        status: 'active' | 'banned';
        tags: string[];
        balance?: string;
      }
    >
  >,

  // the database interface: keyed by table name, non-tables filtered out
  Expect<Equal<keyof DB, 'user'>>,
  Expect<Equal<DB['user'], UserTable>>,
];

// ── what must not compile ────────────────────────────────────────────────────

defineTable({
  tableName: 'bad_pk',
  columns: t => ({ id: t.uuid() }),
  // @ts-expect-error no such column
  primaryKey: { columns: ['nope'] },
});

defineTable({
  tableName: 'bad_fk',
  columns: t => ({ userId: t.uuid() }),
  // @ts-expect-error the target table has no such column
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['nope']) }],
});

defineTable({
  tableName: 'bad_index',
  columns: t => ({ id: t.uuid() }),
  // @ts-expect-error no such column
  indexes: [{ columns: ['id', 'missing'] }],
});

// ── jsonb: writes only through the helpers ───────────────────────────────────

interface Profile {
  readonly theme: 'light' | 'dark';
}

const documentTable = defineTable({
  tableName: 'document',
  columns: t => ({
    id: t.integer().generatedAlwaysAsIdentity(),
    payload: t.jsonb(),
    profile: t.jsonb().$type<Profile>().notNull(),
    history: t.jsonb().array(),
    tags: t.varchar().array().notNull(),
  }),
  primaryKey: { columns: ['id'] },
});

type DocumentTable = inferKyselyTable<typeof documentTable>;
type DocumentDB = inferKyselyDatabase<{ documentTable: typeof documentTable }>;

export type JsonbTests = [
  Expect<
    Equal<
      Simplify<Selectable<DocumentTable>>,
      { id: number; payload: unknown; profile: Profile; history: unknown[] | null; tags: string[] }
    >
  >,
  Expect<
    Equal<
      Simplify<Insertable<DocumentTable>>,
      { payload?: Jsonb<unknown> | null; profile: Jsonb<Profile>; history?: Jsonb<unknown>[] | null; tags: string[] }
    >
  >,
];

export const insertViaHelpers: InsertObject<DocumentDB, 'document'> = {
  profile: jsonb({ theme: 'dark' }),
  payload: jsonb([1, 'two', { three: 3 }]),
  history: jsonbArray([{ a: 1 }, [2], 'three']),
  tags: ['a', 'b'],
};

export const updateViaHelpers: UpdateObject<DocumentDB, 'document'> = {
  payload: jsonb('plain'),
  history: null,
};

// @ts-expect-error a raw object instead of jsonb()
export const rawObject: InsertObject<DocumentDB, 'document'> = { profile: { theme: 'dark' }, tags: [] };

// @ts-expect-error a JSON string without the brand
export const rawString: InsertObject<DocumentDB, 'document'> = { profile: JSON.stringify({ theme: 'dark' }), tags: [] };

// @ts-expect-error the value does not fit Profile
export const wrongShape: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'blue' }), tags: [] };

// @ts-expect-error jsonb[] needs jsonbArray(), not an array of jsonb()
export const wrongArray: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'dark' }), tags: [], history: [jsonb(1)] };

// ── null and undefined: SQL NULL as a plain null, JSON null cannot go through the helper
export const sqlNull: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'dark' }), tags: [], payload: null };

// @ts-expect-error jsonb(null) would write JSON null, not SQL NULL
export const jsonNull: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'dark' }), tags: [], payload: jsonb(null) };

// @ts-expect-error undefined cannot be serialized
export const jsonUndefined: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'dark' }), tags: [], payload: jsonb(undefined) };

declare const anything: unknown;
// @ts-expect-error unknown must be narrowed to a value
export const jsonUnknown: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'dark' }), tags: [], payload: jsonb(anything) };

// inside an array null is a regular JSON element
export const nullInArray: InsertObject<DocumentDB, 'document'> = { profile: jsonb({ theme: 'dark' }), tags: [], history: jsonbArray([1, null]) };

// ── casing: like CamelCasePlugin ─────────────────────────────────────────────

export type CasingTests = [
  Expect<Equal<SnakeCase<'createdAt'>, 'created_at'>>,
  Expect<Equal<SnakeCase<'appleID'>, 'apple_id'>>,
  Expect<Equal<SnakeCase<'fooBAR'>, 'foo_bar'>>,
  Expect<Equal<SnakeCase<'URL'>, 'url'>>,
  Expect<Equal<SnakeCase<'line2Total'>, 'line2_total'>>,
  Expect<Equal<SnakeCase<'UserId'>, 'user_id'>>,
  Expect<Equal<SnakeCase<'id'>, 'id'>>,
  Expect<Equal<SnakeCase<''>, ''>>,
  Expect<Equal<CamelCase<'created_at'>, 'createdAt'>>,
  Expect<Equal<CamelCase<'user_id'>, 'userId'>>,
  Expect<Equal<CamelCase<'a__b'>, 'aB'>>,
  Expect<Equal<CamelCase<'_foo'>, '_Foo'>>,
  Expect<Equal<CamelCase<'field_2'>, 'field2'>>,
  Expect<Equal<CamelCase<'foo_'>, 'foo'>>,
  Expect<Equal<CamelCase<'id'>, 'id'>>,
];

// ── camelCase type mode: second parameter true ───────────────────────────────

const auditLogTable = defineTable({
  tableName: 'audit_log',
  columns: t => ({
    id: t.integer().generatedAlwaysAsIdentity(),
    userId: t.uuid().notNull(),
    happenedAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  primaryKey: { columns: ['id'] },
});

type CamelUser = inferKyselyTable<typeof userTable, true>;
type CamelDB = inferKyselyDatabase<{ userTable: typeof userTable; auditLogTable: typeof auditLogTable; other: 1 }, true>;
type SnakeDB = inferKyselyDatabase<{ userTable: typeof userTable; auditLogTable: typeof auditLogTable }>;

export type CamelModeTests = [
  Expect<Equal<keyof CamelUser, 'id' | 'createdAt' | 'nickname' | 'email' | 'status' | 'legacyId' | 'tags' | 'balance'>>,
  Expect<Equal<Selectable<CamelUser>['createdAt'], Date>>,
  Expect<Equal<Simplify<Insertable<CamelUser>>['legacyId' extends keyof Insertable<CamelUser> ? 'legacyId' : never], never>>,
  Expect<Equal<keyof CamelDB, 'user' | 'auditLog'>>,
  Expect<Equal<keyof CamelDB['auditLog'], 'id' | 'userId' | 'happenedAt'>>,
  Expect<Equal<keyof SnakeDB, 'user' | 'audit_log'>>,
  Expect<Equal<keyof SnakeDB['audit_log'], 'id' | 'user_id' | 'happened_at'>>,
  // an explicit false is the same as no parameter
  Expect<Equal<inferKyselyDatabase<{ userTable: typeof userTable }, false>, inferKyselyDatabase<{ userTable: typeof userTable }>>>,
];
