# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

## [0.7.0] — 2026-09-12

### Added

- `loadTables(patterns, options?)`: the tables for `generateMigration`, found by
  glob instead of listed by hand —
  `await loadTables('../schema-core/src/lib/tables/**/*.table.ts')`. Takes one
  pattern or a list, resolves them against `cwd`, supports `*`, `**`, `?`,
  `{a,b}` and `!` exclusions, and has no dependency of its own. Every matched
  file is imported and every exported table collected, sorted by table name; a
  barrel re-export counts once. Strict, because a missed table reads as a
  dropped one: an empty match, a file that fails to import, two tables with the
  same database name and a foreign key to a table outside the match are all
  errors.
- `isTable(value)`: what `loadTables` uses to pick tables out of a module. Tables
  carry a `Symbol.for` brand now, so a table defined in a package with its own
  copy of kysely-ddl is still recognized.

## [0.6.0] — 2026-09-12

### Changed

- **Breaking:** the `inferKyselyTable` and `inferKyselyDatabase` types are
  `InferKyselyTable` and `InferKyselyDatabase`: PascalCase, like every other
  type. Only the case changes.

## [0.5.0] — 2026-09-12

### Changed

- `enum()` takes any array typed as string literals, not only a list written in
  place: Zod's `.options`, `Object.values()` of a string enum and a `const` array
  all work, and the column type stays the union of the values. A `string[]` is
  still refused, now with a message saying why instead of a tuple mismatch, and
  so is an empty list.

## [0.4.0] — 2026-09-12

### Changed

- **Breaking:** the `kysely` peer dependency is `>=0.29`. `kysely-ddl/migrator`
  takes the `Migration` and `MigrationProvider` types from `kysely/migration`,
  a subpath that exists since Kysely 0.29.0, so the declared `>=0.28` was never
  true for that entry point. CI now runs the checks on 0.29.0 as well as on the
  lockfile version.
- **Breaking:** expressions are Kysely's own `sql` template tag, imported from
  `kysely`; `kysely-ddl` no longer exports a `sql` of its own. The `c.column`
  references in `checks` and `where` are column fragments, `${value}` is inlined
  as an escaped literal (DDL has no bind parameters) and fragments nest: a
  fragment inside a fragment, `sql.join`, `sql.lit` and `sql.raw` all work.
  Rendering goes through Kysely's Postgres query compiler. The `Sql` type is now
  an alias of `RawBuilder<unknown>`; the `ColumnRef`, `Literal` and `SqlChunk`
  types are gone. `inArray`, `renderSql`, `collectColumns`, `quoteIdentifier`
  and `quoteLiteral` stay.
- `defineTable` renders every default, check and partial index condition once,
  at definition time: a value that cannot be inlined (a `Date`, an object, an
  array) is an error naming the table and the column, index or check, instead
  of a failure later in the generator.
- **Breaking:** one builder per column type, in `src/table/column-types/`.
  `defaultNow()` exists on timestamp columns only and
  `generatedAlwaysAsIdentity()` on integer and bigint columns only; an array
  column is a plain column and has neither. The chain keeps its builder, so
  `t.timestamp().notNull().defaultNow()` works. The column config and spec
  carry `kind`, the base postgres type, exported as `ColumnKind`;
  `TimestampColumnBuilder` and `IntegerColumnBuilder` are exported; `AnyColumn`
  is now the `{ _, spec }` shape `defineTable` needs rather than the builder
  class.

## [0.3.0] — 2026-09-12

### Added

- `{ bigint: true }` in the infer options: `bigint()` columns as `bigint` and
  `bigint().array()` columns as `bigint[]`, for a driver that returns int8 that
  way (`Bun.SQL` with `{ bigint: true }`, `pg` with a type parser for oid 20 and,
  for arrays, 1016). A column with `$type<T>()` keeps `T`. The `InferOptions`
  type is exported.

### Changed

- **Breaking:** the second type parameter of `inferKyselyTable` and
  `inferKyselyDatabase` is an options object instead of a boolean:
  `inferKyselyDatabase<typeof schema, true>` becomes
  `inferKyselyDatabase<typeof schema, { camelCase: true }>`.

## [0.2.0] — 2026-09-12

### Added

- `concurrently: true` on an index in `defineTable`: the index is built and
  dropped with `CONCURRENTLY`. Postgres refuses that inside a transaction and
  inside a multi-statement query, so the generator writes such statements into a
  migration of their own, `<stamp>_<name>_concurrently.sql`, marked
  `--> no-transaction` and split by `--> statement-breakpoint`, with a
  `DROP INDEX CONCURRENTLY IF EXISTS` in front of every create so that a rerun
  after a failure is clean. `GenerateResult.concurrently` holds these
  statements. Toggling the flag on an existing index is not a change; the
  snapshot records it, and older snapshots read as `false`.
- `--> no-transaction`: a header marker in a `.sql` migration. The runner honors
  it under `transaction: 'each'` and `'none'` and rejects it under `'all'`
  before applying anything. `sqlFileMigrationProvider` turns it into
  `config: { transaction: false }` for Kysely 0.30+
  (`transactionMode: 'per-migration'`); on older Kysely the marked migration
  fails with a clear error when the `Migrator` runs it inside a transaction.
- `MigrationError.line`: the line postgres pointed at inside the failing query.
- `readMigration`, `renderConcurrentStatements`, `NO_TRANSACTION_MARKER`,
  `CONCURRENTLY_SUFFIX` and the `MigrationFile` type.

### Changed

- **Breaking:** entry points. `kysely-ddl/kysely` is gone: `inferKyselyTable`,
  `inferKyselyDatabase`, `jsonb`, `jsonbArray` and the `Jsonb` type now come
  from `kysely-ddl`, which therefore imports `kysely`, the peer dependency, at
  runtime. The runner (`createMigrator`, `migrateToLatest`, `MigrationError`,
  `DEFAULT_JOURNAL_TABLE`, `MIGRATION_LOCK_ID` and their types) and
  `sqlFileMigrationProvider` moved to the new `kysely-ddl/migrator`, so that a
  project which applies its migrations some other way does not pull them in.
- **Breaking:** the `defineTable` option `tableName` is now `name`.
- **Breaking:** the runner's default `transaction` mode is `'each'` instead of
  `'all'`, so that a generated `_concurrently` migration runs out of the box.
  Pass `transaction: 'all'` to keep the whole run atomic.
- **Breaking:** `writeMigration` returns the names of the files written, an
  array, instead of one name.
- **Breaking:** a `Change` of kind `dropIndex` carries `concurrently`.
- Ordinary migrations are written as plain SQL, without
  `--> statement-breakpoint`, and the runner sends such a file to postgres as
  one query: postgres runs it as one implicit transaction and reports the
  failing line. Files with breakpoints, hand-written or `_concurrently`, are
  still sent one chunk at a time.

## [0.1.0] — 2026-09-10

First release.

### Added

- `defineTable`, `ref`, `sql`, `inArray`: PostgreSQL tables as code. Column
  names are kept as literals in the types, index and constraint names are
  generated automatically and fit into 63 bytes. snake_case of property names
  follows the `CamelCasePlugin` rule (`appleID` -> `apple_id`); `toSnakeCase`,
  `toCamelCase`, `SnakeCase`, `CamelCase` are exported.
- `generateMigration`: diff of the schema against the snapshot of the latest
  migration, returning the SQL, individual statements and the new snapshot.
- `writeMigration`, `readLatestSnapshot`, `listMigrations`: migrations on disk as
  flat `.sql` files with the `--> statement-breakpoint` separator and a single
  `snapshot.json`; file names are monotonic.
- `kysely-ddl/kysely`:
  - `inferKyselyTable`, `inferKyselyDatabase`: Kysely table types keyed by the
    column names in the database; with `true` as the second parameter the keys
    are camelCase for `CamelCasePlugin`;
  - `jsonb`, `jsonbArray` and the `Jsonb<T>` type: jsonb values with an explicit
    `::text::jsonb` cast that behaves the same on `pg` and `Bun.SQL`; jsonb
    columns require them in the write types; the helper rejects `null` and
    `undefined`, SQL NULL is passed as is;
  - `createMigrator` / `migrateToLatest`: running `.sql` migrations through a
    ready `Kysely`: status, three transaction modes, `allowUnordered`, an error
    naming the failing statement; the journal and the lock are compatible with
    Kysely's `Migrator`;
  - `sqlFileMigrationProvider`: a `.sql` file provider for Kysely's `Migrator`.
