/**
 * kysely-ddl: PostgreSQL schema as code, SQL migration generation and the
 * Kysely side of it, row types and jsonb values. Imports `kysely`, the peer
 * dependency, and no driver.
 *
 * Layers and dependency direction:
 *
 *   table ◄── generator ◄── migrator/store ◄── migrator (runner, provider)
 *   table ◄── kysely (row types, jsonb values)
 *
 * Entry points:
 *
 *   kysely-ddl           — this file: tables, generation, migration files on disk,
 *                          `inferKyselyTable` / `inferKyselyDatabase`, `jsonb` / `jsonbArray`
 *   kysely-ddl/migrator  — running migrations: `createMigrator` / `migrateToLatest`
 *                          and `sqlFileMigrationProvider`; separate, so that a project
 *                          which applies migrations some other way does not pull it in
 *
 * Exports are sorted by module path: generator (snapshot, diff, render,
 * facade), kysely (row types, jsonb values), migrator (files on disk), table
 * (table definitions).
 */
export { diffSnapshots } from './generator/diff.ts';
export type { Change, Constraint } from './generator/diff.ts';
export { generateMigration } from './generator/generate.ts';
export type { GenerateResult } from './generator/generate.ts';
export { renderChange, renderChanges, renderConcurrentStatements, renderStatements } from './generator/render.ts';
export { buildSnapshot, EMPTY_SNAPSHOT, SNAPSHOT_VERSION } from './generator/snapshot.ts';
export type { ColumnSnapshot, Snapshot, TableSnapshot } from './generator/snapshot.ts';
export type { inferKyselyDatabase, inferKyselyTable, InferOptions } from './kysely/infer.ts';
export { jsonb, jsonbArray } from './kysely/json.ts';
export type { Jsonb } from './kysely/json.ts';
export {
  CONCURRENTLY_SUFFIX,
  listMigrations,
  MIGRATION_EXTENSION,
  migrationTimestamp,
  NO_TRANSACTION_MARKER,
  readLatestSnapshot,
  readMigration,
  readStatements,
  SNAPSHOT_FILE,
  STATEMENT_SEPARATOR,
  writeMigration,
} from './migrator/store.ts';
export type { MigrationFile } from './migrator/store.ts';
export { toCamelCase, toSnakeCase } from './table/casing.ts';
export type { CamelCase, SnakeCase } from './table/casing.ts';
export { ColumnBuilder, columnBuilders } from './table/columns.ts';
export type { AnyColumn, ColumnBuilders, ColumnCfg, ColumnSpec, DefaultValue } from './table/columns.ts';
export { AUTO_NAMES, defineTable, ref } from './table/define.ts';
export type {
  AnyTable,
  ForeignKeyDef,
  Reference,
  ReferentialAction,
  ResolveColumns,
  ResolvedColumn,
  ResolvedColumnCfg,
  Table,
  TableOptions,
  TableSpec,
} from './table/define.ts';
export { assertIdentifier, autoName, fitIdentifier, MAX_IDENTIFIER_BYTES } from './table/identifier.ts';
export { collectColumns, inArray, quoteIdentifier, quoteLiteral, renderSql, sql } from './table/sql.ts';
export type { ColumnRef, Literal, Sql, SqlChunk } from './table/sql.ts';
