import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type Dialect, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { NO_TRANSACTION_MARKER, STATEMENT_SEPARATOR } from '../src/index.ts';
import { createMigrator, DEFAULT_JOURNAL_TABLE, migrateToLatest, MigrationError } from '../src/kysely/index.ts';

import { BunSqlDialect } from './helpers/bun-dialect.ts';
import { ADMIN_URL, columnNames, createTempDatabase, query, tableNames, type TempDatabase } from './helpers/database.ts';
import { addMigration, addMigrations, ticketTable, ticketTableIndexed, userTable, userTableV2 } from './helpers/schema.ts';

const describeDb = ADMIN_URL === undefined ? describe.skip : describe;

let tempDb: TempDatabase;
let dir: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kysely-ddl-runner-'));

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

/** A hand-written migration, for checking errors and transactions. */
function writeRaw(name: string, statements: readonly string[]): void {
  fs.writeFileSync(path.join(dir, `${name}.sql`), `${statements.join(`\n${STATEMENT_SEPARATOR}\n`)}\n`);
}

/** The same test set runs through both dialects, pg and Bun.SQL. */
const dialects: { readonly label: string; readonly create: (url: string) => Dialect }[] = [
  { label: 'PostgresDialect over pg', create: url => new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }) },
  { label: 'BunSqlDialect over Bun.SQL', create: url => new BunSqlDialect(url) },
];

for (const { label, create } of dialects) {
  describeDb(`createMigrator: ${label}`, () => {
    let db: Kysely<any>;

    beforeEach(() => {
      db = new Kysely<any>({ dialect: create(tempDb.url) });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test('applies pending migrations and keeps the journal like Kysely', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      const tickets = addMigration(dir, 'add_tickets', [userTable, ticketTable]);

      const migrator = createMigrator({ db, migrationsDir: dir });

      expect(await migrator.status()).toEqual({ applied: [], pending: [init, tickets] });
      expect(await migrator.toLatest()).toEqual({ applied: [init, tickets] });
      expect(await migrator.status()).toEqual({ applied: [init, tickets], pending: [] });
      expect(await migrator.toLatest()).toEqual({ applied: [] });

      expect(await tableNames(tempDb.url)).toEqual([DEFAULT_JOURNAL_TABLE, 'ticket', 'user']);

      const journal = await query<{ name: string; timestamp: string }>(
        tempDb.url,
        `select name, timestamp from ${DEFAULT_JOURNAL_TABLE} order by name`,
      );
      expect(journal.map(row => row.name)).toEqual([init, tickets]);

      for (const row of journal) {
        expect(Number.isNaN(Date.parse(row.timestamp))).toBe(false);
      }
    });

    test('migrateToLatest: applies new migrations on the next call too', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      expect(await migrateToLatest({ db, migrationsDir: dir })).toEqual({ applied: [init] });

      const v2 = addMigration(dir, 'add_email', [userTableV2]);
      expect(await migrateToLatest({ db, migrationsDir: dir })).toEqual({ applied: [v2] });

      expect(await columnNames(tempDb.url, 'user')).toEqual(['id', 'nickname', 'balance', 'created_at', 'email']);
    });

    test('journalTable: a custom journal table name', async () => {
      addMigration(dir, 'init', [userTable]);
      await migrateToLatest({ db, migrationsDir: dir, journalTable: 'schema_journal' });
      expect(await tableNames(tempDb.url)).toEqual(['schema_journal', 'user']);
    });

    test('an empty migrations folder: nothing to apply, the journal is still created', async () => {
      expect(await migrateToLatest({ db, migrationsDir: dir })).toEqual({ applied: [] });
      expect(await tableNames(tempDb.url)).toEqual([DEFAULT_JOURNAL_TABLE]);
    });

    test('Kysely keeps working after the run', async () => {
      addMigration(dir, 'init', [userTable]);
      await migrateToLatest({ db, migrationsDir: dir });

      await db.insertInto('user').values({ nickname: 'alice' }).execute();
      expect(await db.selectFrom('user').select('nickname').execute()).toEqual([{ nickname: 'alice' }]);
    });

    test('a failing statement: MigrationError with context, transaction=all rolls back the whole run', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)']);
      writeRaw('20260101000001_b', ['create table b (id int)', 'create table b_oops (id nope)']);

      const error = await migrateToLatest({ db, migrationsDir: dir, transaction: 'all' }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(MigrationError);
      const failure = error as MigrationError;
      expect(failure.migration).toBe('20260101000001_b');
      expect(failure.statement).toBe('create table b_oops (id nope)');
      expect(failure.applied).toEqual(['20260101000000_a']);
      expect(failure.message).toContain('20260101000001_b');
      expect(failure.message).toContain('b_oops');
      expect(failure.cause).toBeInstanceOf(Error);

      expect(await tableNames(tempDb.url)).toEqual([DEFAULT_JOURNAL_TABLE]);
    });

    test('transaction=each: migrations before the failing one stay applied', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)']);
      writeRaw('20260101000001_b', ['create table b (id int)', 'create table b_oops (id nope)']);

      await expect(migrateToLatest({ db, migrationsDir: dir, transaction: 'each' })).rejects.toBeInstanceOf(MigrationError);

      expect(await tableNames(tempDb.url)).toEqual(['a', DEFAULT_JOURNAL_TABLE]);
      expect(await createMigrator({ db, migrationsDir: dir }).status()).toEqual({
        applied: ['20260101000000_a'],
        pending: ['20260101000001_b'],
      });
    });

    test('transaction=none: statements are not rolled back, the failing migration is not recorded', async () => {
      writeRaw('20260101000000_b', ['create table b (id int)', 'create table b_oops (id nope)']);

      await expect(migrateToLatest({ db, migrationsDir: dir, transaction: 'none' })).rejects.toBeInstanceOf(MigrationError);

      expect(await tableNames(tempDb.url)).toEqual(['b', DEFAULT_JOURNAL_TABLE]);
    });

    test('transaction=none allows CREATE INDEX CONCURRENTLY, transaction=all does not', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)', 'create index concurrently a_id_idx on a (id)']);

      await expect(migrateToLatest({ db, migrationsDir: dir, transaction: 'all' })).rejects.toBeInstanceOf(MigrationError);
      expect(await migrateToLatest({ db, migrationsDir: dir, transaction: 'none' })).toEqual({
        applied: ['20260101000000_a'],
      });
    });

    test('a journal migration missing on disk is an error', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      await migrateToLatest({ db, migrationsDir: dir });
      fs.rmSync(path.join(dir, `${init}.sql`));

      const migrator = createMigrator({ db, migrationsDir: dir });
      await expect(migrator.status()).rejects.toThrow(new RegExp(`missing on disk: ${init}`));
      await expect(migrator.toLatest()).rejects.toThrow(/missing on disk/);
    });

    test('a pending migration sorting before an applied one is an error; allowUnordered applies it', async () => {
      writeRaw('20260101000001_b', ['create table b (id int)']);
      await migrateToLatest({ db, migrationsDir: dir });

      writeRaw('20260101000000_a', ['create table a (id int)']);
      await expect(migrateToLatest({ db, migrationsDir: dir })).rejects.toThrow(/allowUnordered/);

      expect(await migrateToLatest({ db, migrationsDir: dir, allowUnordered: true })).toEqual({
        applied: ['20260101000000_a'],
      });
    });

    test('concurrent runs: the lock makes every migration apply exactly once', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)', 'select pg_sleep(0.3)']);
      writeRaw('20260101000001_b', ['create table b (id int)']);

      const results = await Promise.all([1, 2, 3].map(() => migrateToLatest({ db, migrationsDir: dir })));

      expect(results.flatMap(result => result.applied).toSorted()).toEqual(['20260101000000_a', '20260101000001_b']);

      const journal = await query<{ n: number }>(tempDb.url, `select count(*)::int as n from ${DEFAULT_JOURNAL_TABLE}`);
      expect(journal[0]?.n).toBe(2);
    });

    test('a Transaction instead of Kysely is an error', async () => {
      await db.transaction().execute(async trx => {
        expect(() => createMigrator({ db: trx, migrationsDir: dir })).toThrow(/Transaction/);
      });
    });
  });
}

describe('createMigrator: checks without a database', () => {
  const fakeDb = { isTransaction: false } as unknown as Kysely<any>;

  test('an invalid journalTable name is an error before connecting', () => {
    expect(() => createMigrator({ db: fakeDb, migrationsDir: '.', journalTable: 'bad name' })).toThrow(/journalTable/);
    expect(() => createMigrator({ db: fakeDb, migrationsDir: '.', journalTable: 'drop table x;' })).toThrow(/journalTable/);
  });
});

/** A hand-written migration with the `--> no-transaction` marker in the header. */
function writeNoTransaction(name: string, statements: readonly string[]): void {
  fs.writeFileSync(
    path.join(dir, `${name}.sql`),
    `${NO_TRANSACTION_MARKER}\n${statements.join(`\n${STATEMENT_SEPARATOR}\n`)}\n`,
  );
}

for (const { label, create } of dialects) {
  describeDb(`createMigrator: ${label}: ${NO_TRANSACTION_MARKER}`, () => {
    let db: Kysely<any>;

    beforeEach(() => {
      db = new Kysely<any>({ dialect: create(tempDb.url) });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test('transaction=each: a marked migration runs outside a transaction, the one before it inside', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)']);
      writeNoTransaction('20260101000001_idx', ['create index concurrently a_id_idx on a (id)']);

      expect(await migrateToLatest({ db, migrationsDir: dir, transaction: 'each' })).toEqual({
        applied: ['20260101000000_a', '20260101000001_idx'],
      });

      const indexes = await query<{ indexname: string }>(tempDb.url, `select indexname from pg_indexes where tablename = 'a'`);
      expect(indexes.map(row => row.indexname)).toEqual(['a_id_idx']);
    });

    test('transaction=each: a failing marked migration is not recorded, its earlier statements stay', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)']);
      writeNoTransaction('20260101000001_bad', ['create table c (id int)', 'create index concurrently oops on a (nope)']);

      await expect(migrateToLatest({ db, migrationsDir: dir, transaction: 'each' })).rejects.toBeInstanceOf(MigrationError);

      expect(await tableNames(tempDb.url)).toEqual(['a', 'c', DEFAULT_JOURNAL_TABLE]);
      expect(await createMigrator({ db, migrationsDir: dir }).status()).toEqual({
        applied: ['20260101000000_a'],
        pending: ['20260101000001_bad'],
      });
    });

    test('transaction=all: a marked migration is an error before anything is applied', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)']);
      writeNoTransaction('20260101000001_idx', ['create index concurrently a_id_idx on a (id)']);

      await expect(migrateToLatest({ db, migrationsDir: dir, transaction: 'all' })).rejects.toThrow(
        /20260101000001_idx.*no-transaction.*'each'/s,
      );
      expect(await tableNames(tempDb.url)).toEqual([DEFAULT_JOURNAL_TABLE]);
    });

    test('transaction=none: a marked migration simply runs, there is nothing to opt out of', async () => {
      writeNoTransaction('20260101000000_idx', ['create table a (id int)', 'create index concurrently a_id_idx on a (id)']);

      expect(await migrateToLatest({ db, migrationsDir: dir, transaction: 'none' })).toEqual({ applied: ['20260101000000_idx'] });
    });
  });
}

for (const { label, create } of dialects) {
  describeDb(`createMigrator: ${label}: whole-file queries and generated concurrent indexes`, () => {
    let db: Kysely<any>;

    beforeEach(() => {
      db = new Kysely<any>({ dialect: create(tempDb.url) });
    });

    afterEach(async () => {
      await db.destroy();
    });

    test('a file without breakpoints goes to postgres as one query', async () => {
      fs.writeFileSync(path.join(dir, '20260101000000_ab.sql'), 'create table a (id int);\ncreate table b (id int);\n');

      expect(await migrateToLatest({ db, migrationsDir: dir, transaction: 'none' })).toEqual({ applied: ['20260101000000_ab'] });
      expect(await tableNames(tempDb.url)).toEqual(['a', 'b', DEFAULT_JOURNAL_TABLE]);
    });

    test('a failing statement in a whole-file query: the error names the line, postgres rolled the file back', async () => {
      fs.writeFileSync(
        path.join(dir, '20260101000000_ab.sql'),
        'create table ok1 (id int);\ncreate table bad (id nope);\ncreate table ok2 (id int);\n',
      );

      const error = await migrateToLatest({ db, migrationsDir: dir, transaction: 'none' }).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(MigrationError);
      const failure = error as MigrationError;
      expect(failure.line).toBe(2);
      expect(failure.message).toContain('line 2');
      // several statements in one query are one implicit transaction even without BEGIN
      expect(await tableNames(tempDb.url)).toEqual([DEFAULT_JOURNAL_TABLE]);
    });

    test('a generated concurrent index: the table migration in a transaction, the index one outside', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      const tickets = addMigrations(dir, 'tickets', [userTable, ticketTableIndexed]);
      expect(tickets).toHaveLength(2);

      expect(await migrateToLatest({ db, migrationsDir: dir, transaction: 'each' })).toEqual({ applied: [init, ...tickets] });

      const indexes = await query<{ indisvalid: boolean }>(
        tempDb.url,
        `select x.indisvalid from pg_index x join pg_class c on c.oid = x.indexrelid where c.relname = 'ticket_user_id_idx'`,
      );
      expect(indexes).toEqual([{ indisvalid: true }]);
    });

    test('transaction=all names the generated concurrent migration in its error, nothing is applied', async () => {
      addMigration(dir, 'init', [userTable]);
      const [, concurrently] = addMigrations(dir, 'tickets', [userTable, ticketTableIndexed]);

      await expect(migrateToLatest({ db, migrationsDir: dir, transaction: 'all' })).rejects.toThrow(
        new RegExp(`${concurrently}.*'each'`, 's'),
      );
      expect(await tableNames(tempDb.url)).toEqual([DEFAULT_JOURNAL_TABLE]);
    });

    test('the default is transaction=each: the generated pair applies without options', async () => {
      const init = addMigration(dir, 'init', [userTable]);
      const tickets = addMigrations(dir, 'tickets', [userTable, ticketTableIndexed]);

      expect(await migrateToLatest({ db, migrationsDir: dir })).toEqual({ applied: [init, ...tickets] });
    });

    test('the default is transaction=each, not none: a failing file rolls back only itself', async () => {
      writeRaw('20260101000000_a', ['create table a (id int)']);
      writeRaw('20260101000001_b', ['create table b (id int)', 'create table b_oops (id nope)']);

      await expect(migrateToLatest({ db, migrationsDir: dir })).rejects.toBeInstanceOf(MigrationError);
      // 'all' would leave only the journal, 'none' would keep b as well
      expect(await tableNames(tempDb.url)).toEqual(['a', DEFAULT_JOURNAL_TABLE]);
    });
  });
}
