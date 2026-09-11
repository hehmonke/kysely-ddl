# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
