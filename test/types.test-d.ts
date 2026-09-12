/**
 * Type-level checks. The file is never executed, only `tsc` reads it
 * (`bun run typecheck`); a failing `Expect` is a compile error.
 */
import { type Insertable, type InsertObject, type Selectable, sql, type UpdateObject } from 'kysely';

import {
  type CamelCase,
  defineTable,
  type InferKyselyDatabase,
  type InferKyselyTable,
  type Jsonb,
  jsonb,
  jsonbArray,
  ref,
  type SnakeCase,
} from '../src/index.ts';

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the standard trick for comparing types
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Simplify<T> = { [K in keyof T]: T[K] } & {};

type UUID = string & { readonly __brand: 'uuid' };

const userTable = defineTable({
  name: 'user',
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

type UserTable = InferKyselyTable<typeof userTable>;
type DB = InferKyselyDatabase<typeof schema>;

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
  name: 'bad_pk',
  columns: t => ({ id: t.uuid() }),
  // @ts-expect-error no such column
  primaryKey: { columns: ['nope'] },
});

defineTable({
  name: 'bad_fk',
  columns: t => ({ userId: t.uuid() }),
  // @ts-expect-error the target table has no such column
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['nope']) }],
});

defineTable({
  name: 'bad_index',
  columns: t => ({ id: t.uuid() }),
  // @ts-expect-error no such column
  indexes: [{ columns: ['id', 'missing'] }],
});

// ── jsonb: writes only through the helpers ───────────────────────────────────

interface Profile {
  readonly theme: 'light' | 'dark';
}

const documentTable = defineTable({
  name: 'document',
  columns: t => ({
    id: t.integer().generatedAlwaysAsIdentity(),
    payload: t.jsonb(),
    profile: t.jsonb().$type<Profile>().notNull(),
    history: t.jsonb().array(),
    tags: t.varchar().array().notNull(),
  }),
  primaryKey: { columns: ['id'] },
});

type DocumentTable = InferKyselyTable<typeof documentTable>;
type DocumentDB = InferKyselyDatabase<{ documentTable: typeof documentTable }>;

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

// ── options: { camelCase: true }, like CamelCasePlugin ───────────────────────

const auditLogTable = defineTable({
  name: 'audit_log',
  columns: t => ({
    id: t.integer().generatedAlwaysAsIdentity(),
    userId: t.uuid().notNull(),
    happenedAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  primaryKey: { columns: ['id'] },
});

type CamelUser = InferKyselyTable<typeof userTable, { camelCase: true }>;
type CamelDB = InferKyselyDatabase<
  { userTable: typeof userTable; auditLogTable: typeof auditLogTable; other: 1 },
  { camelCase: true }
>;
type SnakeDB = InferKyselyDatabase<{ userTable: typeof userTable; auditLogTable: typeof auditLogTable }>;

export type CamelModeTests = [
  Expect<Equal<keyof CamelUser, 'id' | 'createdAt' | 'nickname' | 'email' | 'status' | 'legacyId' | 'tags' | 'balance'>>,
  Expect<Equal<Selectable<CamelUser>['createdAt'], Date>>,
  Expect<Equal<Simplify<Insertable<CamelUser>>['legacyId' extends keyof Insertable<CamelUser> ? 'legacyId' : never], never>>,
  Expect<Equal<keyof CamelDB, 'user' | 'auditLog'>>,
  Expect<Equal<keyof CamelDB['auditLog'], 'id' | 'userId' | 'happenedAt'>>,
  Expect<Equal<keyof SnakeDB, 'user' | 'audit_log'>>,
  Expect<Equal<keyof SnakeDB['audit_log'], 'id' | 'user_id' | 'happened_at'>>,
  // an explicit false is the same as no options
  Expect<
    Equal<InferKyselyDatabase<{ userTable: typeof userTable }, { camelCase: false }>, InferKyselyDatabase<{ userTable: typeof userTable }>>
  >,
];

// ── options: { bigint: true }, for a driver that returns int8 as BigInt ──────

type LegacyId = string & { readonly __brand: 'legacy' };

const ledgerTable = defineTable({
  name: 'ledger',
  columns: t => ({
    seq: t.bigint().generatedAlwaysAsIdentity(),
    amount: t.bigint().notNull(),
    limit: t.bigint(),
    history: t.bigint().array().notNull(),
    legacyId: t.bigint().$type<LegacyId>(),
    total: t.numeric().notNull(),
    code: t.varchar().notNull(),
  }),
  primaryKey: { columns: ['seq'] },
});

type Ledger = InferKyselyTable<typeof ledgerTable>;
type BigLedger = InferKyselyTable<typeof ledgerTable, { bigint: true }>;
type BigCamelDB = InferKyselyDatabase<{ ledgerTable: typeof ledgerTable }, { camelCase: true; bigint: true }>;

export type BigintModeTests = [
  // by default int8 is a string, like numeric: what pg and Bun.SQL return
  Expect<
    Equal<
      Simplify<Selectable<Ledger>>,
      { seq: string; amount: string; limit: string | null; history: string[]; legacy_id: LegacyId | null; total: string; code: string }
    >
  >,
  // with the option every bigint() column reads and writes as bigint, arrays as bigint[];
  // $type<T>() keeps T, numeric stays a string
  Expect<
    Equal<
      Simplify<Selectable<BigLedger>>,
      { seq: bigint; amount: bigint; limit: bigint | null; history: bigint[]; legacy_id: LegacyId | null; total: string; code: string }
    >
  >,
  Expect<
    Equal<
      Simplify<Insertable<BigLedger>>,
      { amount: bigint; limit?: bigint | null; history: bigint[]; legacy_id?: LegacyId | null; total: string; code: string }
    >
  >,
  // the options combine
  Expect<Equal<keyof BigCamelDB, 'ledger'>>,
  Expect<Equal<keyof BigCamelDB['ledger'], 'seq' | 'amount' | 'limit' | 'history' | 'legacyId' | 'total' | 'code'>>,
  Expect<Equal<Selectable<BigCamelDB['ledger']>['amount'], bigint>>,
  Expect<Equal<Selectable<BigCamelDB['ledger']>['legacyId'], LegacyId | null>>,
  // an explicit false is the default
  Expect<Equal<InferKyselyTable<typeof ledgerTable, { bigint: false }>, Ledger>>,
];

// ── the boolean form of the second parameter must not compile ────────────────

// @ts-expect-error the second parameter is an options object: { camelCase: true }
export type OldCamel = InferKyselyDatabase<{ userTable: typeof userTable }, true>;

// @ts-expect-error no such option
export type Typo = InferKyselyDatabase<{ userTable: typeof userTable }, { camelcase: true }>;

// ── the old option name must not compile ─────────────────────────────────────

// @ts-expect-error tableName was renamed to name
defineTable({ tableName: 'old', columns: t => ({ id: t.uuid() }) });

// ── one builder per column type: a modifier is offered where it applies ──────

defineTable({
  name: 'per_type',
  columns: t => ({
    // @ts-expect-error defaultNow() exists on timestamp columns only
    a: t.uuid().defaultNow(),
    // @ts-expect-error an array column is a plain column: no defaultNow()
    b: t.timestamp().array().defaultNow(),
    // @ts-expect-error generatedAlwaysAsIdentity() exists on integer and bigint columns only
    c: t.uuid().generatedAlwaysAsIdentity(),
    // @ts-expect-error an array column is a plain column: no identity
    d: t.integer().array().generatedAlwaysAsIdentity(),
  }),
});

// the chain keeps its builder: the modifiers of the type stay available after the shared ones
const perTypeOk = defineTable({
  name: 'per_type_ok',
  columns: t => ({
    a: t.timestamp().notNull().defaultNow(),
    b: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    c: t.timestamp().$type<string>().defaultNow(),
    d: t.bigint().generatedAlwaysAsIdentity(),
    e: t.integer('n').notNull().generatedAlwaysAsIdentity(),
    f: t.varchar().array().notNull().default(sql`'{}'`),
  }),
  primaryKey: { columns: ['d'] },
});

export type PerTypeTests = [
  Expect<Equal<(typeof perTypeOk)['_']['columns']['a']['kind'], 'timestamp'>>,
  Expect<Equal<(typeof perTypeOk)['_']['columns']['d']['kind'], 'bigint'>>,
  Expect<Equal<(typeof userTable)['_']['columns']['status']['kind'], 'varchar'>>,
];

// ── enum(): the values may come from anywhere typed as string literals ───────

declare const statusOptions: ('new' | 'in-progress' | 'closed')[]; // the shape of Zod 4's `.options`
const STATES = ['on', 'off'] as const;
enum Level {
  Low = 'low',
  High = 'high',
}
declare const plainStrings: string[];

const enumSourcesTable = defineTable({
  name: 'enum_sources',
  columns: t => ({
    status: t.enum(statusOptions).notNull(),
    state: t.enum(STATES).notNull(),
    level: t.enum(Object.values(Level)).notNull(),
    named: t.enum('named_col', statusOptions).notNull(),
  }),
});

type EnumSources = InferKyselyTable<typeof enumSourcesTable>;

export type EnumSourceTests = [
  Expect<Equal<Selectable<EnumSources>['status'], 'new' | 'in-progress' | 'closed'>>,
  Expect<Equal<Selectable<EnumSources>['state'], 'on' | 'off'>>,
  Expect<Equal<Selectable<EnumSources>['level'], Level.Low | Level.High>>,
  Expect<Equal<Selectable<EnumSources>['named_col'], 'new' | 'in-progress' | 'closed'>>,
  Expect<Equal<(typeof enumSourcesTable)['_']['columns']['status']['enumValues'], ('new' | 'in-progress' | 'closed')[]>>,
];

defineTable({
  name: 'enum_bad',
  columns: t => ({
    // @ts-expect-error string[] carries no literals: the column would be typed string
    a: t.enum(plainStrings),
    // @ts-expect-error an empty list
    b: t.enum([]),
    // @ts-expect-error string[] carries no literals, with a name as well
    c: t.enum('c', plainStrings),
  }),
});
