# kysely-ddl

[![CI](https://github.com/hehmonke/kysely-ddl/actions/workflows/ci.yml/badge.svg)](https://github.com/hehmonke/kysely-ddl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kysely-ddl)](https://www.npmjs.com/package/kysely-ddl)

PostgreSQL schema as TypeScript code, SQL migrations generated from snapshot
diffs, Kysely table types, and a migration runner on top of your `Kysely`.

- **PostgreSQL only.** Tested with `pg` (Node and Bun) and with `Bun.SQL` through a Kysely dialect.
- **Column names stay literal in the types**, so the Kysely interface is derived
  from the column names in the database, without casing plugins or conventions.
- **Diffs are computed against a snapshot**, not a live database: generation is deterministic.
- **Migrations are plain `.sql` files**, run either by the built-in runner or by
  Kysely's `Migrator`: the journal is shared.

## Installation

```bash
bun add kysely-ddl kysely
# or
npm install kysely-ddl kysely
```

`kysely >= 0.28` is a peer dependency. The driver is yours: `pg` under Node or
Bun, or any PostgreSQL dialect for Kysely. Runtime: Node >= 20 or Bun >= 1.2.

## Entry points

| import | contents |
|---|---|
| `kysely-ddl` | table definitions, migration generation, migration files on disk. Does not import Kysely |
| `kysely-ddl/kysely` | `inferKyselyTable`, `inferKyselyDatabase`, `jsonb` / `jsonbArray`, `createMigrator` / `migrateToLatest`, `sqlFileMigrationProvider` |

## Quick start

`schema.ts`, the tables:

```ts
import { defineTable, ref, sql } from 'kysely-ddl';

export const userTable = defineTable({
  tableName: 'user',
  // builders arrive as an argument; they are not exported one by one
  columns: t => ({
    // no explicit column name -> derived from the property: created_at, apple_id, ...
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    nickname: t.varchar().notNull(),
    email: t.varchar(),
    status: t.enum(['active', 'banned']).notNull(),
  }),
  // no explicit names -> user_pk, user_nickname_idx, user_nickname_check
  primaryKey: { columns: ['id'] },
  indexes: [{ unique: true, columns: ['nickname'] }],
  checks: [{ expression: c => sql`char_length(${c.nickname}) >= 2` }],
});

export const sessionTable = defineTable({
  tableName: 'session',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    userId: t.uuid().notNull(),
  }),
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
});
```

`generate.ts`, a new migration diffed against the latest snapshot:

```ts
import { generateMigration, readLatestSnapshot, writeMigration } from 'kysely-ddl';
import * as schema from './schema';

const dir = './migrations';
const result = generateMigration([schema.userTable, schema.sessionTable], readLatestSnapshot(dir));

if (result.statements.length === 0) {
  console.log('no changes');
} else {
  console.log(writeMigration(dir, process.argv[2] ?? 'migration', result)); // 20260910123045_migration
}
```

`migrate.ts`, applying migrations:

```ts
import { migrateToLatest } from 'kysely-ddl/kysely';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) }) });

try {
  const { applied } = await migrateToLatest({ db, migrationsDir: './migrations' });
  console.log(applied.length === 0 ? 'nothing to apply' : `applied: ${applied.join(', ')}`);
} finally {
  await db.destroy();
}
```

Types for queries:

```ts
import type { inferKyselyDatabase } from 'kysely-ddl/kysely';
import * as schema from './schema';

type DB = inferKyselyDatabase<typeof schema>;
const db = new Kysely<DB>({ dialect });

const rows = await db.selectFrom('user').select(['nickname', 'created_at']).execute();
//    ^? { nickname: string; created_at: Date }[]
```

## Describing tables

A hybrid: columns as chains, everything else as a declarative block.

| | |
|---|---|
| column types | `t.uuid` `t.varchar({ length })` `t.integer` `t.bigint` `t.boolean` `t.numeric({ precision, scale })` `t.timestamp({ withTimezone, precision })` `t.jsonb` `t.enum([...])` |
| modifiers | `.notNull()` `.default(v \| sql)` `.defaultNow()` `.array()` `.$type<T>()` `.generatedAlwaysAsIdentity()` |
| table | `primaryKey` (composite too), `uniques`, `indexes` (unique and partial via `where`), `foreignKeys` (`onDelete` / `onUpdate`), `checks`; names are optional everywhere |
| expressions | `` sql`...` `` with column and literal interpolation, `inArray(c.status, [...])` |

When a column name is not given, it is derived from the property name with the
same snake_case rule as Kysely's `CamelCasePlugin`: `createdAt` -> `created_at`,
`appleID` -> `apple_id`. A name can also be set explicitly, `t.uuid('id')`, and
then it is what ends up in the type. The builder takes the name first and the
config second: `t.varchar('title', { length: 200 })`.

TypeScript value types match what the driver returns, without modes like
`bigint({ mode })`: `bigint` and `numeric` are strings (no precision loss),
`timestamp` is `Date`, `jsonb` is `unknown`. For another type use `$type<T>()`
and convert on your side.

### `enum([...])`

The column stays `varchar`, the allowed values go into a check constraint named
`{table}_{column}_check`, and in TypeScript it is a union of string literals:

```sql
"status" varchar NOT NULL,
CONSTRAINT "user_status_check" CHECK ("status" in ('active', 'banned'))
```

There is deliberately no native `create type ... as enum`: a new value cannot be
used in the same transaction that adds it, which breaks exactly when migrations
run in a single transaction. Changing the value list of `varchar` + check is a
regular `ALTER TABLE ... DROP CONSTRAINT ..., ADD CONSTRAINT ...`, and the diff
catches it. `enum().array()` is not supported yet.

### Foreign keys

The target is given through `ref(table, [columns])`, so TypeScript checks the
column names on both sides, and single-column and composite keys look the same:

```ts
foreignKeys: [
  { columns: ['ticketId', 'locale'], references: ref(ticketTranslationTable, ['ticketId', 'locale']), onDelete: 'cascade' },
],
```

Foreign keys are always emitted as separate `ALTER TABLE` statements after all
`CREATE TABLE`s, so declaration order and circular references do not matter.

### Names: auto-generation and the postgres limit

| object | pattern | example |
|---|---|---|
| primary key | `{table}_pk` | `user_pk` |
| unique | `{table}_{columns}_uq` | `ticket_number_uq` |
| foreign key | `{table}_{columns}_fk` | `session_user_id_fk` |
| check | `{table}_{expression columns}_check` | `ticket_status_check` |
| index | `{table}_{columns}_idx` | `user_resource_transaction_user_id_resource_idx` |

Postgres identifiers are limited to **63 bytes**, and anything longer is silently
truncated. The snapshot would remember the long name, the database would hold
the short one, and the diff would forever try to create the "missing" index.
So auto-names are shortened deterministically with a hash suffix derived from
the full name, while an explicit name over the limit is a `defineTable` error.
Collisions are caught too: two objects on the same columns, an index named like
a unique constraint, a check with neither columns nor a name, two properties
mapping to the same database name.

### What is missing

Native enums, stored generated columns, schemas other than `public`, views,
`DEFERRABLE`, covering indexes, index methods other than btree. Everything is
added the same way: a field in `TableSpec` -> a field in the snapshot -> a branch
in the diff -> a branch in the renderer.

## Types for Kysely

```ts
import type { inferKyselyDatabase, inferKyselyTable } from 'kysely-ddl/kysely';
import type { Insertable, Selectable } from 'kysely';

type UserTable = inferKyselyTable<typeof userTable>;
type DB = inferKyselyDatabase<typeof schema>; // anything that is not a table is filtered out

type UserRow = Selectable<UserTable>;
type NewUser = Insertable<UserTable>;
```

Keys are **the column names in the database**: they are known at the type level
because `defineTable` keeps them as literals. With Kysely's `CamelCasePlugin`
pass `true` as the second parameter and the column and table keys become
camelCase, see below. Write rules:

| column | `Insertable` |
|---|---|
| `notNull()` without a default | required field |
| has `default()` / `defaultNow()` | optional |
| nullable | optional, accepts `null` |
| `generatedAlwaysAsIdentity()` | no key at all |
| `jsonb()` | branded `Jsonb<T>`: values only through the `jsonb()` helper, `jsonbArray()` for `jsonb[]` |

### CamelCasePlugin

`CamelCasePlugin` rewrites camelCase in code to snake_case in SQL and back in
result row keys. To have the types reflect that, both `infer` types take `true`
as the second parameter:

```ts
import { CamelCasePlugin, Kysely } from 'kysely';

type DB = inferKyselyDatabase<typeof schema, true>;
const db = new Kysely<DB>({ dialect, plugins: [new CamelCasePlugin()] });

await db.selectFrom('auditLog').select(['userId', 'happenedAt']).execute();
// select "user_id", "happened_at" from "audit_log"
//    ^? { userId: string; happenedAt: Date }[]
```

Keys are computed from the database names with the same algorithm as the plugin
with default options (`created_at` -> `createdAt`), and `toSnakeCase` in
`defineTable` follows the same rule: consecutive capitals are not split,
`appleID` gives `apple_id`, `parseJSONValue` gives `parse_jsonvalue`. So names
derived from properties round-trip without loss, while explicit names deserve a
check: the plugin does not restore an underscore before a digit (`field_2`) or a
leading underscore. Plugin options (`upperCase`, `underscoreBeforeDigits`,
`underscoreBetweenUppercaseLetters`) are not supported by the types. The
conversions themselves are exported too: the types `SnakeCase`, `CamelCase` and
the functions `toSnakeCase`, `toCamelCase`.

### jsonb: values through `jsonb()` and `jsonbArray()`

Drivers disagree on how a jsonb parameter should be passed, and there is no raw
representation both accept: `pg` expects a JSON string and turns a JS array into
a postgres array literal (`invalid input syntax for type json`), while `Bun.SQL`
expects a raw value and encodes a ready JSON string a second time. The helpers
build an expression with an explicit `$1::text::jsonb` cast that both understand,
and the `Jsonb<T>` brand in the write types keeps raw objects and strings from
slipping past them:

```ts
import { jsonb, jsonbArray } from 'kysely-ddl/kysely';

await db.insertInto('user').values({ settings: jsonb({ theme: 'dark', tags: ['a'] }) }).execute();
await db.updateTable('user').set({ settings: jsonb({ theme: 'light' }) }).where('id', '=', id).execute();
await db.selectFrom('user').selectAll().where('settings', '@>', jsonb({ theme: 'dark' })).execute();

await db.insertInto('audit').values({ changes: jsonbArray([{ field: 'a' }, { field: 'b' }]) }).execute(); // jsonb[]
```

`jsonb()` accepts an object, an array, a string, a number or a boolean. It does
not accept `null` or `undefined`: `jsonb(null)` would write JSON null rather than
SQL NULL, which passes a `NOT NULL` column, is invisible to `IS NULL` and
`COALESCE`, and is indistinguishable from SQL NULL when read. SQL NULL for a
nullable column is passed as a plain `null` without the helper. Inside objects
and arrays `null` stays regular JSON.

The type inside `Jsonb<T>` comes from the column's `$type<T>()`, so
`jsonb({ theme: 'blue' })` does not compile for `$type<{ theme: 'light' | 'dark' }>()`.
On read, jsonb arrives as a parsed value with both drivers.

## Generating migrations

```ts
const result = generateMigration(tables, previousSnapshot);
// result.sql        — the migration text; '' when there are no changes
// result.statements — the same SQL as individual statements
// result.snapshot   — the state after the migration; writeMigration stores it
// result.changes    — the parsed changes, handy for a "what changed" summary
```

### Layout on disk

```
migrations/
  20260910120000_init.sql
  20260910123000_add_tickets.sql
  snapshot.json
```

`writeMigration(dir, name, result)` writes the `.sql` file and updates
`snapshot.json`, `readLatestSnapshot(dir)` reads it for the next diff, and
`listMigrations(dir)` returns names in the order the runner applies them (by
character codes, like Kysely). There is no separate journal on disk: the table in
the database knows what has been applied.

Inside a `.sql` file, statements are separated by the `--> statement-breakpoint`
comment: the file stays valid for `psql`, and the runner splits on it to execute
statements one at a time so that an error points at a specific statement.

Names are monotonic: if the previous migration was created in the same second,
the timestamp is bumped forward, otherwise the suffix would decide the order.

There is a single snapshot describing the state after the latest migration. The
price is merge conflicts: two branches that each add a migration diverge in
`snapshot.json`, and it has to be regenerated after the merge.

### Statement order

Fixed, so it does not depend on the order tables are declared in:

```
DROP INDEX -> DROP CONSTRAINT -> CREATE TABLE -> ADD COLUMN -> ALTER COLUMN
  -> ADD / REPLACE CONSTRAINT -> CREATE INDEX -> ADD FOREIGN KEY
  -> DROP COLUMN -> DROP TABLE
```

`PRIMARY KEY`, `UNIQUE` and `CHECK` of a new table go inside `CREATE TABLE`.
Replacing a constraint is a single `ALTER TABLE ... DROP CONSTRAINT ..., ADD CONSTRAINT ...`.
`DROP COLUMN` and `DROP TABLE` are printed as is, so review a migration before
committing it.

### Why diff against a snapshot, not the database

Postgres normalizes expressions on save: `x in (...)` becomes
`x = ANY (ARRAY[...])`, `trim(x)` becomes `TRIM(BOTH FROM x)`. A tool that reads
the schema back from the database gets a perpetual diff on the same checks. The
snapshot compares two representations produced by the same code. The price is
that database drift (someone edited the schema by hand) is invisible to it.

## Running migrations

The runner takes a ready `Kysely` with any PostgreSQL dialect and works through a
single connection (`db.connection()`): the lock and the transaction live on it.

```ts
import { createMigrator, migrateToLatest } from 'kysely-ddl/kysely';

const migrator = createMigrator({
  db,                          // a Kysely instance, not a Transaction
  migrationsDir: './migrations',
  journalTable: 'kysely_migration', // the default, same as Kysely
  transaction: 'all',          // 'all' | 'each' | 'none'
  allowUnordered: false,
});

await migrator.status();   // { applied: string[], pending: string[] }
await migrator.toLatest(); // { applied: string[] }, what this run applied

await migrateToLatest({ db, migrationsDir: './migrations' }); // the same in one line
```

| option | effect |
|---|---|
| `transaction: 'all'` | the whole run in one transaction, like Kysely: a failing migration rolls back the earlier ones from the same run |
| `transaction: 'each'` | one transaction per migration: the ones before the failure stay applied |
| `transaction: 'none'` | no transactions, for `CREATE INDEX CONCURRENTLY` and the like |
| `allowUnordered` | apply migrations that sort before already applied ones (branch merges). An error by default |

A failing statement throws `MigrationError` with `migration`, `statement`,
`applied` (what this run applied before the failure) and the driver's `cause`.
A migration present in the journal but missing on disk is an error: restore the
file from history or delete the row by hand.

Concurrent runs are safe: the runner takes a session-level advisory lock with the
same key as Kysely's `Migrator` and re-reads the journal after waiting.

### Compatibility with Kysely's `Migrator`

The journal is the same `kysely_migration` table with the same columns, and the
lock is the same `pg_advisory_lock`. So `.sql` migrations can also be run by the
built-in `Migrator`, and the two runners can alternate on one database:

```ts
import { sqlFileMigrationProvider } from 'kysely-ddl/kysely';
import { Migrator } from 'kysely/migration';

const migrator = new Migrator({ db, provider: sqlFileMigrationProvider('./migrations') });
const { error, results } = await migrator.migrateToLatest();
```

There are no rollbacks: the generator only writes forward. Without `down`,
Kysely skips a migration on `migrateDown` (`NotExecuted`) and leaves it in the
journal, so by default the provider supplies a `down` that fails with a clear
error: a rollback must not look successful.
`sqlFileMigrationProvider(dir, { onDown: 'skip' })` restores Kysely's behaviour.

### Under Bun

`pg` works under Bun as is. The built-in `Bun.SQL` is connected through any
PostgreSQL dialect for Kysely; the package does not ship one. A test
implementation lives in `test/helpers/bun-dialect.ts`, and the whole suite runs
through it alongside `pg`.

### Driver differences

What the checks showed on `pg` 8.23 and `Bun.SQL` 1.4 (parameters via Kysely):

| value -> column | `pg` | `Bun.SQL` | what to do |
|---|---|---|---|
| object -> `jsonb` | ok | ok | `jsonb(obj)`, works everywhere |
| JS array -> `jsonb` | error: postgres array literal | ok | `jsonb([...])` |
| JSON string -> `jsonb` | ok | encoded twice, into a jsonb string | `jsonb(value)` |
| number, boolean -> `jsonb` | ok | parameter type error | `jsonb(42)` |
| array of objects -> `jsonb[]` | ok | error: arrays are not encoded | `jsonbArray([...])` |
| array of strings -> `varchar[]` | ok, including commas, quotes, `null` | error: elements joined with commas | a Bun dialect must encode arrays into literals itself, as the test one does |
| `numeric` = 0 on read | `'0.00'` | `'0'` | compare as numbers |

Reading jsonb, JSON arrays, `jsonb[]` and `varchar[]` yields parsed JS values
with both drivers.

## Development

```bash
bun install
bun run db:up                                   # postgres:18-alpine on 54329
DATABASE_URL=postgres://postgres:postgres@localhost:54329/kysely_ddl bun test
bun run typecheck && bun run lint && bun run build
DATABASE_URL=... bun run smoke:node             # the built dist under Node with pg
```

Without `DATABASE_URL` the integration tests are skipped, the unit tests always
run. Type-level checks live in `test/types.test-d.ts` and are read by `tsc` only.

Releases are tagged `vX.Y.Z`, matching `version` in `package.json`: GitHub
Actions runs the checks and does `npm publish` with provenance. Authentication is
npm trusted publishing (OIDC) configured on npmjs.com for this repository and
the `publish.yml` workflow, so no token secret is needed.

## License

MIT.
