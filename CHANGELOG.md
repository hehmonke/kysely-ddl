# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

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
