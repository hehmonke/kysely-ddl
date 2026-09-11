import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CamelCasePlugin, type Dialect, type InsertObject, Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';

import {
  defineTable,
  type inferKyselyDatabase,
  type Jsonb,
  jsonb,
  jsonbArray,
  NO_TRANSACTION_MARKER,
  ref,
} from '../src/index.ts';
import { createMigrator, migrateToLatest, sqlFileMigrationProvider } from '../src/migrator/index.ts';

import { BunSqlDialect } from './helpers/bun-dialect.ts';
import { ADMIN_URL, createTempDatabase, query, tableNames, type TempDatabase } from './helpers/database.ts';
import { addMigration, documentTable, type Profile, schema, ticketTable, userTable } from './helpers/schema.ts';

type DB = inferKyselyDatabase<typeof schema>;

const describeDb = ADMIN_URL === undefined ? describe.skip : describe;

let tempDb: TempDatabase;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kysely-ddl-kysely-'));

  if (ADMIN_URL !== undefined) {
    tempDb = await createTempDatabase();
  }
});

afterEach(async () => {
  fs.rmSync(dir, { recursive: true, force: true });

  if (ADMIN_URL !== undefined) {
    await tempDb.drop();
  }
});

/** The same test set runs through both dialects, pg and Bun.SQL. */
const dialects: { readonly label: string; readonly create: (url: string) => Dialect }[] = [
  { label: 'PostgresDialect over pg', create: url => new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }) },
  { label: 'BunSqlDialect over Bun.SQL', create: url => new BunSqlDialect(url) },
];

for (const { label, create } of dialects) {
  describeDb(label, () => {
    let db: Kysely<DB>;

    beforeEach(() => {
      db = new Kysely<DB>({ dialect: create(tempDb.url) });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test('sqlFileMigrationProvider: the Kysely Migrator applies .sql files', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      const tickets = addMigration(dir, 'add_tickets', [userTable, ticketTable]);

      const migrator = new Migrator({ db, provider: sqlFileMigrationProvider(dir) });
      const { error, results } = await migrator.migrateToLatest();

      expect(error).toBeUndefined();
      expect(results?.map(result => [result.migrationName, result.status])).toEqual([
        [init, 'Success'],
        [tickets, 'Success'],
      ]);
      expect(await tableNames(tempDb.url)).toEqual(['kysely_migration', 'kysely_migration_lock', 'ticket', 'user']);
    });

    test('both runners share the journal: Kysely sees our migrations and we see its', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      await migrateToLatest({ db, migrationsDir: dir });

      const tickets = addMigration(dir, 'add_tickets', [userTable, ticketTable]);
      const viaKysely = new Migrator({ db, provider: sqlFileMigrationProvider(dir) });
      const { error, results } = await viaKysely.migrateToLatest();

      expect(error).toBeUndefined();
      expect(results?.map(result => result.migrationName)).toEqual([tickets]);

      const seenByKysely = await viaKysely.getMigrations();
      expect(seenByKysely.map(migration => [migration.name, migration.executedAt !== undefined])).toEqual([
        [init, true],
        [tickets, true],
      ]);

      expect(await createMigrator({ db, migrationsDir: dir }).status()).toEqual({ applied: [init, tickets], pending: [] });
    });

    test('migrateDown: without a rollback Kysely does nothing; the provider fails by default, onDown: "skip" stays silent', async () => {
      addMigration(dir, 'init', [userTable]);

      const strict = new Migrator({ db, provider: sqlFileMigrationProvider(dir) });
      expect((await strict.migrateToLatest()).error).toBeUndefined();

      const down = await strict.migrateDown();
      expect(String(down.error)).toMatch(/no rollback available/);

      const lenient = new Migrator({ db, provider: sqlFileMigrationProvider(dir, { onDown: 'skip' }) });
      const skipped = await lenient.migrateDown();
      expect(skipped.error).toBeUndefined();
      expect(skipped.results?.map(result => result.status)).toEqual(['NotExecuted']);

      // the migration stays applied in both cases
      expect(await tableNames(tempDb.url)).toEqual(['kysely_migration', 'kysely_migration_lock', 'user']);
    });

    test('typed queries: insert / select / update / delete', async () => {
      addMigration(dir, 'init', [userTable, ticketTable]);
      await migrateToLatest({ db, migrationsDir: dir });

      const inserted = await db
        .insertInto('user')
        .values([{ nickname: 'alice', balance: '10.50' }, { nickname: 'bob' }])
        .returning(['id', 'nickname', 'balance', 'created_at'])
        .execute();

      expect(inserted.map(row => row.nickname)).toEqual(['alice', 'bob']);
      expect(inserted[0]?.balance).toBe('10.50');
      // numeric arrives as a string with both drivers; Bun.SQL prints zero as '0', pg as '0.00'
      expect(Number(inserted[1]?.balance)).toBe(0);
      expect(inserted[0]?.created_at).toBeInstanceOf(Date);

      await db
        .insertInto('ticket')
        .values({ user_id: inserted[0]!.id, status: 'new' })
        .execute();

      const joined = await db
        .selectFrom('ticket')
        .innerJoin('user', 'user.id', 'ticket.user_id')
        .select(['user.nickname', 'ticket.status'])
        .execute();
      expect(joined).toEqual([{ nickname: 'alice', status: 'new' }]);

      const updated = await db.updateTable('user').set({ balance: '1' }).where('nickname', '=', 'bob').executeTakeFirst();
      expect(updated.numUpdatedRows).toBe(1n);

      const deleted = await db.deleteFrom('user').where('nickname', '=', 'alice').executeTakeFirst();
      expect(deleted.numDeletedRows).toBe(1n);

      expect(await db.selectFrom('user').select('nickname').execute()).toEqual([{ nickname: 'bob' }]);
      expect(await db.selectFrom('ticket').select('id').execute()).toEqual([]); // on delete cascade
    });

    test('a transaction rolls back as a whole, the isolation level is configurable', async () => {
      addMigration(dir, 'init', [userTable]);
      await migrateToLatest({ db, migrationsDir: dir });

      await expect(
        db.transaction().execute(async trx => {
          await trx.insertInto('user').values({ nickname: 'ghost' }).execute();
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      await db
        .transaction()
        .setIsolationLevel('serializable')
        .execute(trx => trx.insertInto('user').values({ nickname: 'real' }).execute());

      expect(await db.selectFrom('user').select('nickname').orderBy('nickname').execute()).toEqual([{ nickname: 'real' }]);
    });

    test('introspection sees the tables', async () => {
      addMigration(dir, 'init', [userTable, ticketTable]);
      await migrateToLatest({ db, migrationsDir: dir });

      const tables = await db.introspection.getTables({ withInternalKyselyTables: false });
      expect(tables.map(table => table.name).toSorted()).toEqual(['ticket', 'user']);
    });
  });
}


for (const { label, create } of dialects) {
  describeDb(`${label}: jsonb and arrays`, () => {
    let db: Kysely<DB>;

    beforeEach(async () => {
      db = new Kysely<DB>({ dialect: create(tempDb.url) });
      addMigration(dir, 'init', [userTable, ticketTable, documentTable]);
      await migrateToLatest({ db, migrationsDir: dir });
    });

    afterEach(async () => {
      await db.destroy();
    });

    const insert = (name: string, values: Partial<InsertObject<DB, 'document'>>) =>
      db
        .insertInto('document')
        .values({ label: name, profile: jsonb({ theme: 'dark', tags: [] }), tags: [], ...values })
        .execute();

    const read = (name: string) => db.selectFrom('document').selectAll().where('label', '=', name).executeTakeFirstOrThrow();

    test('jsonb: object, JSON array, string, number, boolean and null come back as is', async () => {
      await insert('object', { payload: jsonb({ foo: 'zoo', nested: { a: [1, 2] }, quote: 'x"y, {z}' }) });
      await insert('array', { payload: jsonb([1, 'two', { three: 3 }, [4]]) });
      await insert('string', { payload: jsonb('plain, with "quotes"') });
      await insert('number', { payload: jsonb(42) });
      await insert('boolean', { payload: jsonb(false) });
      await insert('sql null', { payload: null });
      // JSON null cannot go through the helper, only raw SQL, and that is deliberate
      await insert('json null', { payload: sql<Jsonb<unknown>>`'null'::jsonb` });

      expect((await read('object')).payload).toEqual({ foo: 'zoo', nested: { a: [1, 2] }, quote: 'x"y, {z}' });
      expect((await read('array')).payload).toEqual([1, 'two', { three: 3 }, [4]]);
      expect((await read('string')).payload).toBe('plain, with "quotes"');
      expect((await read('number')).payload).toBe(42);
      expect((await read('boolean')).payload).toBe(false);
      expect((await read('json null')).payload).toBeNull();
      expect((await read('sql null')).payload).toBeNull();

      // JSON null and SQL NULL are different things, only SQL can tell them apart
      const sqlNulls = await db.selectFrom('document').select('label').where(sql<boolean>`payload is null`).execute();
      expect(sqlNulls).toEqual([{ label: 'sql null' }]);
    });

    test('typed jsonb: $type<Profile>() and back', async () => {
      const profile: Profile = { theme: 'light', tags: ['a', 'b,c'] };
      await insert('typed', { profile: jsonb(profile) });

      const row = await read('typed');
      expect(row.profile).toEqual(profile);
      expect(row.profile.theme).toBe('light');
    });

    test('jsonb[]: an array of JSON values through jsonbArray()', async () => {
      const history = [{ at: 1, change: 'x,y' }, [1, 2], 'note "quoted"', 7, null];
      await insert('history', { history: jsonbArray(history) });
      await insert('empty history', { history: jsonbArray([]) });
      await insert('null history', { history: null });

      expect((await read('history')).history).toEqual(history);
      expect((await read('empty history')).history).toEqual([]);
      expect((await read('null history')).history).toBeNull();
    });

    test('varchar[]: commas, quotes, braces, empty strings and an empty array', async () => {
      const tags = ['a', 'b,c', 'd"e', 'f\\g', '{h}', '', 'null', 'NULL', 'ünï', ' sp '];
      await insert('tags', { tags });
      await insert('no tags', { tags: [] });

      expect((await read('tags')).tags).toEqual(tags);
      expect((await read('no tags')).tags).toEqual([]);
    });

    test('update through set() with jsonb() and a jsonb operator in where', async () => {
      await insert('upd', { payload: jsonb({ v: 1 }) });

      const result = await db
        .updateTable('document')
        .set({ payload: jsonb({ v: 2, list: [1] }) })
        .where('label', '=', 'upd')
        .executeTakeFirst();
      expect(result.numUpdatedRows).toBe(1n);
      expect((await read('upd')).payload).toEqual({ v: 2, list: [1] });

      const found = await db.selectFrom('document').select('label').where('payload', '@>', jsonb({ v: 2 })).execute();
      expect(found).toEqual([{ label: 'upd' }]);
    });
  });
}

// ── CamelCasePlugin: camelCase keys in the types, snake_case in SQL ──────────

const auditLogTable = defineTable({
  name: 'audit_log',
  columns: t => ({
    id: t.integer().generatedAlwaysAsIdentity(),
    userId: t.uuid().notNull(),
    happenedAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    payload: t.jsonb(),
  }),
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
});

type CamelDB = inferKyselyDatabase<{ userTable: typeof userTable; auditLogTable: typeof auditLogTable }, true>;

for (const { label, create } of dialects) {
  describeDb(`${label}: CamelCasePlugin`, () => {
    let db: Kysely<CamelDB>;

    beforeEach(async () => {
      db = new Kysely<CamelDB>({ dialect: create(tempDb.url), plugins: [new CamelCasePlugin()] });
      addMigration(dir, 'init', [userTable, auditLogTable]);
      await migrateToLatest({ db, migrationsDir: dir });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test('the runner works under the plugin, tables are created in snake_case', async () => {
      expect(await tableNames(tempDb.url)).toEqual(['audit_log', 'kysely_migration', 'user']);
      expect((await createMigrator({ db, migrationsDir: dir }).status()).pending).toEqual([]);
    });

    test('camelCase in code, snake_case in the database, camelCase row keys', async () => {
      const user = await db
        .insertInto('user')
        .values({ nickname: 'alice' })
        .returning(['id', 'createdAt', 'nickname'])
        .executeTakeFirstOrThrow();
      expect(user.createdAt).toBeInstanceOf(Date);

      await db.insertInto('auditLog').values({ userId: user.id, payload: jsonb({ action: 'login' }) }).execute();

      const rows = await db
        .selectFrom('auditLog')
        .innerJoin('user', 'user.id', 'auditLog.userId')
        .select(['user.nickname', 'auditLog.happenedAt', 'auditLog.payload'])
        .where('auditLog.userId', '=', user.id)
        .execute();

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).toSorted()).toEqual(['happenedAt', 'nickname', 'payload']);
      expect(rows[0]!.nickname).toBe('alice');
      expect(rows[0]!.happenedAt).toBeInstanceOf(Date);
      expect(rows[0]!.payload).toEqual({ action: 'login' });

      const compiled = db.selectFrom('auditLog').select(['auditLog.userId', 'auditLog.happenedAt']).compile();
      expect(compiled.sql).toBe('select "audit_log"."user_id", "audit_log"."happened_at" from "audit_log"');
    });
  });
}

// ── --> no-transaction through Kysely's Migrator ─────────────────────────────

for (const { label, create } of dialects) {
  describeDb(`${label}: sqlFileMigrationProvider and ${NO_TRANSACTION_MARKER}`, () => {
    let db: Kysely<DB>;
    let init: string;
    const index = '99990101000000_user_balance_idx';

    beforeEach(() => {
      db = new Kysely<DB>({ dialect: create(tempDb.url) });
      init = addMigration(dir, 'init', [userTable]);
      fs.writeFileSync(
        path.join(dir, `${index}.sql`),
        `${NO_TRANSACTION_MARKER}\ncreate index concurrently user_balance_idx on "user" (balance);\n`,
      );
    });

    afterEach(async () => {
      await db.destroy();
    });

    test('the marker becomes config: { transaction: false }, the field Kysely 0.30 reads; other migrations have no config', async () => {
      const migrations = await sqlFileMigrationProvider(dir).getMigrations();

      expect(Object.keys(migrations)).toEqual([init, index]);
      expect(migrations[init]).not.toHaveProperty('config');
      expect(migrations[index]).toHaveProperty('config', { transaction: false });
    });

    test('inside the Migrator transaction the marked migration refuses to run and names the fix', async () => {
      const migrator = new Migrator({ db, provider: sqlFileMigrationProvider(dir) });
      const { error, results } = await migrator.migrateToLatest();

      expect(String(error)).toMatch(/no-transaction/);
      expect(String(error)).toMatch(/per-migration/);
      expect(results?.map(result => result.status)).toEqual(['Success', 'Error']);
      // the whole run is one transaction, so the first migration was rolled back too
      expect(await tableNames(tempDb.url)).toEqual(['kysely_migration', 'kysely_migration_lock']);
    });

    test('without the Migrator transaction the marked migration builds the index', async () => {
      const migrator = new Migrator({ db, provider: sqlFileMigrationProvider(dir), disableTransactions: true });
      const { error } = await migrator.migrateToLatest();

      expect(error).toBeUndefined();
      const indexes = await query<{ indexname: string }>(
        tempDb.url,
        `select indexname from pg_indexes where indexname = 'user_balance_idx'`,
      );
      expect(indexes).toHaveLength(1);
    });
  });
}
