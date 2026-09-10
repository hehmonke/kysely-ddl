/**
 * kysely-ddl: PostgreSQL schema as code and SQL migration generation.
 * Has no runtime dependency on Kysely or on any driver.
 *
 * Layers and dependency direction:
 *
 *   table ◄── generator ◄── migrator ◄── kysely
 *
 * Entry points:
 *
 *   kysely-ddl         — this file: tables, generation, migration files
 *   kysely-ddl/kysely  — row types, migration runner, provider for Migrator
 *
 * Exports are sorted by module path: generator (snapshot, diff, render,
 * facade), migrator (files on disk), table (table definitions).
 */
export { diffSnapshots } from './generator/diff.ts';
export type { Change, Constraint } from './generator/diff.ts';
export { generateMigration } from './generator/generate.ts';
export type { GenerateResult } from './generator/generate.ts';
export { renderChange, renderChanges, renderStatements } from './generator/render.ts';
export { buildSnapshot, EMPTY_SNAPSHOT, SNAPSHOT_VERSION } from './generator/snapshot.ts';
export type { ColumnSnapshot, Snapshot, TableSnapshot } from './generator/snapshot.ts';
export {
  listMigrations,
  MIGRATION_EXTENSION,
  migrationTimestamp,
  readLatestSnapshot,
  readStatements,
  SNAPSHOT_FILE,
  STATEMENT_SEPARATOR,
  writeMigration,
} from './migrator/store.ts';
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
