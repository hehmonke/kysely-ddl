import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defineTable,
  generateMigration,
  listMigrations,
  migrationTimestamp,
  NO_TRANSACTION_MARKER,
  readLatestSnapshot,
  readMigration,
  readStatements,
  SNAPSHOT_FILE,
  STATEMENT_SEPARATOR,
  writeMigration,
} from '../src/index.ts';

const userTable = defineTable({
  name: 'user',
  columns: t => ({ id: t.uuid().notNull(), nickname: t.varchar().notNull() }),
  primaryKey: { columns: ['id'] },
  indexes: [{ columns: ['nickname'] }],
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kysely-ddl-store-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migrationTimestamp', () => {
  test('14 UTC digits', () => {
    expect(migrationTimestamp(new Date(Date.UTC(2026, 8, 10, 12, 30, 45)))).toBe('20260910123045');
  });
});

describe('writeMigration', () => {
  test('writes the .sql as plain SQL without breakpoints and snapshot.json, returns the names', () => {
    const result = generateMigration([userTable]);
    const names = writeMigration(dir, 'init', result);

    expect(names).toEqual([expect.stringMatching(/^\d{14}_init$/)]);
    const name = names[0]!;
    expect(listMigrations(dir)).toEqual([name]);

    const text = fs.readFileSync(path.join(dir, `${name}.sql`), 'utf8');
    expect(text).toBe(result.sql);
    expect(text).not.toContain(STATEMENT_SEPARATOR);
    // the whole file is one execution chunk: postgres runs it as one implicit transaction
    expect(readMigration(dir, name)).toEqual({ statements: [result.sql.trim()], transaction: true });
    expect(readStatements(dir, name)).toEqual([result.sql.trim()]);

    expect(JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_FILE), 'utf8'))).toEqual(result.snapshot);
    expect(readLatestSnapshot(dir)).toEqual(result.snapshot);
  });

  test('names are monotonic: a second migration within the same second is bumped one second forward', () => {
    const [first] = writeMigration(dir, 'init', generateMigration([userTable]));
    const next = generateMigration(
      [defineTable({ name: 'user', columns: t => ({ id: t.uuid().notNull() }), primaryKey: { columns: ['id'] } })],
      readLatestSnapshot(dir),
    );
    const [second] = writeMigration(dir, 'drop_nickname', next);

    expect(second!.slice(0, 14) > first!.slice(0, 14)).toBe(true);
    expect(listMigrations(dir)).toEqual([first!, second!]);
  });

  test('nothing to write is an error', () => {
    const result = generateMigration([userTable]);
    const again = generateMigration([userTable], result.snapshot);
    expect(() => writeMigration(dir, 'noop', again)).toThrow(/nothing to write/);
  });

  test('a migration name is [a-z0-9_] only', () => {
    expect(() => writeMigration(dir, 'Add-Users', generateMigration([userTable]))).toThrow(/only \[a-z0-9_\]/);
  });
});

describe('listMigrations / readLatestSnapshot', () => {
  test('an empty or missing folder yields nothing and EMPTY_SNAPSHOT', () => {
    expect(listMigrations(path.join(dir, 'nope'))).toEqual([]);
    expect(readLatestSnapshot(dir)).toEqual({ version: 1, tables: [] });
  });

  test('sorts like Kysely, by character codes', () => {
    for (const name of ['20260101000000_b.sql', '20260101000000_a.sql', '20250101000000_z.sql', 'snapshot.json', 'notes.txt']) {
      fs.writeFileSync(path.join(dir, name), '');
    }

    expect(listMigrations(dir)).toEqual(['20250101000000_z', '20260101000000_a', '20260101000000_b']);
  });

  test('migrations without a snapshot are an error', () => {
    fs.writeFileSync(path.join(dir, '20260101000000_init.sql'), 'select 1;\n');
    expect(() => readLatestSnapshot(dir)).toThrow(/snapshot\.json is missing/);
  });

  test('readStatements splits on the separator and drops empty chunks', () => {
    fs.writeFileSync(
      path.join(dir, '20260101000000_x.sql'),
      `\nselect 1;\n${STATEMENT_SEPARATOR}\n\n${STATEMENT_SEPARATOR}\nselect 2;\n`,
    );
    expect(readStatements(dir, '20260101000000_x')).toEqual(['select 1;', 'select 2;']);
  });
});

describe('readMigration', () => {
  const name = '20260101000000_x';
  const write = (text: string) => fs.writeFileSync(path.join(dir, `${name}.sql`), text);

  test('without a marker the migration runs in a transaction', () => {
    write(`select 1;\n${STATEMENT_SEPARATOR}\nselect 2;\n`);
    expect(readMigration(dir, name)).toEqual({ statements: ['select 1;', 'select 2;'], transaction: true });
  });

  test(`${NO_TRANSACTION_MARKER} in the header turns the transaction off and is not sent to postgres`, () => {
    write(`${NO_TRANSACTION_MARKER}\ncreate index concurrently i on t (a);\n`);
    expect(readMigration(dir, name)).toEqual({ statements: ['create index concurrently i on t (a);'], transaction: false });
    expect(readStatements(dir, name)).toEqual(['create index concurrently i on t (a);']);
  });

  test('the header may hold blank lines and plain comments around the marker', () => {
    write(`\n-- reports need this index\n${NO_TRANSACTION_MARKER}\n-- built online\n\ncreate index concurrently i on t (a);\n`);
    expect(readMigration(dir, name)).toEqual({
      statements: ['-- reports need this index\n-- built online\n\ncreate index concurrently i on t (a);'],
      transaction: false,
    });
  });

  test('CRLF line endings are fine', () => {
    write(`${NO_TRANSACTION_MARKER}\r\nselect 1;\r\n${STATEMENT_SEPARATOR}\r\nselect 2;\r\n`);
    expect(readMigration(dir, name)).toEqual({ statements: ['select 1;', 'select 2;'], transaction: false });
  });

  test('the marker after the first statement is an error: postgres would take it for a comment', () => {
    write(`select 1;\n${STATEMENT_SEPARATOR}\n${NO_TRANSACTION_MARKER}\nselect 2;\n`);
    expect(() => readMigration(dir, name)).toThrow(/before the first statement/);
  });

  test('an unknown --> marker in the header is an error', () => {
    write(`--> no-transactions\nselect 1;\n`);
    expect(() => readMigration(dir, name)).toThrow(/unknown marker/);
  });
});

describe('writeMigration: concurrently', () => {
  test('concurrent indexes go to a second, marked file split by breakpoints, one second later', () => {
    const ticket = defineTable({
      name: 'ticket',
      columns: t => ({ id: t.uuid().notNull(), userId: t.uuid().notNull(), status: t.varchar() }),
      primaryKey: { columns: ['id'] },
      indexes: [{ columns: ['userId'], concurrently: true }, { columns: ['status'], concurrently: true }],
    });
    const result = generateMigration([ticket]);
    const names = writeMigration(dir, 'add_ticket', result);

    expect(names).toEqual([
      expect.stringMatching(/^\d{14}_add_ticket$/),
      expect.stringMatching(/^\d{14}_add_ticket_concurrently$/),
    ]);
    expect(names[1]!.slice(0, 14) > names[0]!.slice(0, 14)).toBe(true);
    expect(listMigrations(dir)).toEqual(names);

    expect(fs.readFileSync(path.join(dir, `${names[0]}.sql`), 'utf8')).toBe(result.sql);
    expect(fs.readFileSync(path.join(dir, `${names[1]}.sql`), 'utf8')).toBe(
      `${NO_TRANSACTION_MARKER}\n${result.concurrently.join(`\n${STATEMENT_SEPARATOR}\n`)}\n`,
    );
    expect(readMigration(dir, names[1]!)).toEqual({ statements: [...result.concurrently], transaction: false });
    expect(readLatestSnapshot(dir)).toEqual(result.snapshot);
  });

  test('only concurrent changes: just the marked file', () => {
    const v1 = defineTable({ name: 't', columns: t => ({ a: t.integer() }) });
    const v2 = defineTable({ name: 't', columns: t => ({ a: t.integer() }), indexes: [{ columns: ['a'], concurrently: true }] });
    writeMigration(dir, 'init', generateMigration([v1]));

    const names = writeMigration(dir, 'idx', generateMigration([v2], readLatestSnapshot(dir)));

    expect(names).toEqual([expect.stringMatching(/^\d{14}_idx_concurrently$/)]);
    expect(readMigration(dir, names[0]!).transaction).toBe(false);
    expect(listMigrations(dir)).toHaveLength(2);
  });
});
