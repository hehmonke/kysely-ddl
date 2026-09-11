/**
 * Running `.sql` migrations. Entry point `kysely-ddl/migrator`, kept apart from
 * the root one so that a project which applies its migrations some other way
 * (psql, a CI job, a runner of its own) does not pull this in.
 *
 * Two ways to run: `createMigrator` / `migrateToLatest`, a runner on top of a
 * ready `Kysely`, and `sqlFileMigrationProvider`, which feeds the same files to
 * Kysely's own `Migrator`. Both read what `writeMigration` writes; the file
 * format itself (`store.ts` next door) is exported from the root entry point,
 * since generating a migration needs it and running one is optional.
 */
export { sqlFileMigrationProvider } from './provider.ts';
export type { SqlMigrationProviderOptions } from './provider.ts';
export {
  createMigrator,
  DEFAULT_JOURNAL_TABLE,
  migrateToLatest,
  MIGRATION_LOCK_ID,
  MigrationError,
} from './runner.ts';
export type { MigrationRunResult, MigrationStatus, MigratorOptions, SqlMigrator, TransactionMode } from './runner.ts';
