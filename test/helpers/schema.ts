/** A shared mini schema for the integration tests. Defaults use only what postgres 13+ has. */
import { sql } from 'kysely';

import {
  type AnyTable,
  defineTable,
  generateMigration,
  readLatestSnapshot,
  ref,
  writeMigration,
} from '../../src/index.ts';

export const userTable = defineTable({
  name: 'user',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    nickname: t.varchar().notNull(),
    balance: t.numeric({ precision: 12, scale: 2 }).notNull().default('0'),
    createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
  }),
  primaryKey: { columns: ['id'] },
  indexes: [{ unique: true, columns: ['nickname'] }],
});

export const userTableV2 = defineTable({
  name: 'user',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    nickname: t.varchar().notNull(),
    balance: t.numeric({ precision: 12, scale: 2 }).notNull().default('0'),
    createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    email: t.varchar(),
  }),
  primaryKey: { columns: ['id'] },
  indexes: [{ unique: true, columns: ['nickname'] }],
});

export const ticketTable = defineTable({
  name: 'ticket',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    userId: t.uuid().notNull(),
    status: t.enum(['new', 'closed']).notNull(),
  }),
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
});

/** `ticket` with an index built concurrently: the generator writes it as a separate migration. */
export const ticketTableIndexed = defineTable({
  name: 'ticket',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    userId: t.uuid().notNull(),
    status: t.enum(['new', 'closed']).notNull(),
  }),
  primaryKey: { columns: ['id'] },
  indexes: [{ columns: ['userId'], concurrently: true }],
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
});

/** The next migration, diffed against the snapshot in the folder. Exactly one file is expected. */
export function addMigration(dir: string, name: string, tables: readonly AnyTable[]): string {
  const names = addMigrations(dir, name, tables);

  if (names.length !== 1) {
    throw new Error(`addMigration: expected one file, got ${names.join(', ')}; use addMigrations`);
  }

  return names[0]!;
}

/** The same, returning every file written: two when there are concurrent indexes. */
export function addMigrations(dir: string, name: string, tables: readonly AnyTable[]): string[] {
  return writeMigration(dir, name, generateMigration(tables, readLatestSnapshot(dir)));
}

export interface Profile {
  readonly theme: 'light' | 'dark';
  readonly tags: readonly string[];
}

/** jsonb in all its forms, for checking driver differences. */
export const documentTable = defineTable({
  name: 'document',
  columns: t => ({
    id: t.integer().generatedAlwaysAsIdentity(),
    label: t.varchar().notNull(),
    payload: t.jsonb(),
    profile: t.jsonb().$type<Profile>().notNull(),
    history: t.jsonb().array(),
    tags: t.varchar().array().notNull(),
  }),
  primaryKey: { columns: ['id'] },
});

export const schema = { documentTable, ticketTable, userTable };
