/**
 * Facade: schema + previous snapshot -> migration SQL and the new snapshot.
 *
 * How to write it to disk and how to apply it is not this function's concern.
 */
import type { SchemaObject } from '../table/define.ts';

import { type Change, diffSnapshots } from './diff.ts';
import { renderChanges, renderConcurrentStatements, renderStatements } from './render.ts';
import { buildSnapshot, EMPTY_SNAPSHOT, type Snapshot } from './snapshot.ts';

export interface GenerateResult {
  /** The migration text, without the `CONCURRENTLY` statements; an empty string means none. */
  readonly sql: string;
  /** The same SQL statement by statement. */
  readonly statements: readonly string[];
  /**
   * The `CONCURRENTLY` index statements. Postgres refuses them inside a
   * transaction and inside a multi-statement query alike, so `writeMigration`
   * puts them into a migration of their own, marked `--> no-transaction`.
   */
  readonly concurrently: readonly string[];
  /** The snapshot to store next to the migration. */
  readonly snapshot: Snapshot;
  /** Parsed changes; handy for tests and for a "what changed" summary. Empty means nothing to write. */
  readonly changes: readonly Change[];
}

/** Takes tables and the foreign keys `defineForeignKey` declares outside them, in one list. */
export function generateMigration(
  schema: readonly SchemaObject[],
  previous: Snapshot = EMPTY_SNAPSHOT,
): GenerateResult {
  const snapshot = buildSnapshot(schema);
  const changes = diffSnapshots(previous, snapshot);

  return {
    sql: renderChanges(changes),
    statements: renderStatements(changes),
    concurrently: renderConcurrentStatements(changes),
    snapshot,
    changes,
  };
}
