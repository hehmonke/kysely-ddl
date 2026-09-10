/** A shared mini schema for the integration tests. Defaults use only what postgres 13+ has. */
import {
  type AnyTable,
  defineTable,
  generateMigration,
  readLatestSnapshot,
  ref,
  sql,
  writeMigration,
} from '../../src/index.ts';

export const userTable = defineTable({
  tableName: 'user',
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
  tableName: 'user',
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
  tableName: 'ticket',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    userId: t.uuid().notNull(),
    status: t.enum(['new', 'closed']).notNull(),
  }),
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
});

/** The next migration, diffed against the snapshot in the folder. */
export function addMigration(dir: string, name: string, tables: readonly AnyTable[]): string {
  return writeMigration(dir, name, generateMigration(tables, readLatestSnapshot(dir)));
}

export interface Profile {
  readonly theme: 'light' | 'dark';
  readonly tags: readonly string[];
}

/** jsonb in all its forms, for checking driver differences. */
export const documentTable = defineTable({
  tableName: 'document',
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
