/**
 * Facade: schema + previous snapshot -> migration SQL and the new snapshot.
 *
 * How to write it to disk and how to apply it is not this function's concern.
 */
import type { AnyTable } from '../table/define.ts';

import { type Change, diffSnapshots } from './diff.ts';
import { renderChanges, renderStatements } from './render.ts';
import { buildSnapshot, EMPTY_SNAPSHOT, type Snapshot } from './snapshot.ts';

export interface GenerateResult {
  /** Migration SQL; an empty string means no changes. */
  readonly sql: string;
  /** The same SQL as individual statements; the runner executes these. */
  readonly statements: readonly string[];
  /** The snapshot to store next to the migration. */
  readonly snapshot: Snapshot;
  /** Parsed changes; handy for tests and for a "what changed" summary. */
  readonly changes: readonly Change[];
}

export function generateMigration(
  tables: readonly AnyTable[],
  previous: Snapshot = EMPTY_SNAPSHOT,
): GenerateResult {
  const snapshot = buildSnapshot(tables);
  const changes = diffSnapshots(previous, snapshot);

  return { sql: renderChanges(changes), statements: renderStatements(changes), snapshot, changes };
}
