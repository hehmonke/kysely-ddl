import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  defineTable,
  generateMigration,
  listMigrations,
  migrationTimestamp,
  readLatestSnapshot,
  readStatements,
  SNAPSHOT_FILE,
  STATEMENT_SEPARATOR,
  writeMigration,
} from '../src/index.ts';

const userTable = defineTable({
  tableName: 'user',
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
  test('writes the .sql with the separator and snapshot.json, returns the name', () => {
    const result = generateMigration([userTable]);
    const name = writeMigration(dir, 'init', result);

    expect(name).toMatch(/^\d{14}_init$/);
    expect(listMigrations(dir)).toEqual([name]);

    const text = fs.readFileSync(path.join(dir, `${name}.sql`), 'utf8');
    expect(text).toBe(`${result.statements.join(`\n${STATEMENT_SEPARATOR}\n`)}\n`);
    expect(readStatements(dir, name)).toEqual([...result.statements]);

    expect(JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_FILE), 'utf8'))).toEqual(result.snapshot);
    expect(readLatestSnapshot(dir)).toEqual(result.snapshot);
  });

  test('names are monotonic: a second migration within the same second is bumped one second forward', () => {
    const first = writeMigration(dir, 'init', generateMigration([userTable]));
    const next = generateMigration(
      [defineTable({ tableName: 'user', columns: t => ({ id: t.uuid().notNull() }), primaryKey: { columns: ['id'] } })],
      readLatestSnapshot(dir),
    );
    const second = writeMigration(dir, 'drop_nickname', next);

    expect(second.slice(0, 14) > first.slice(0, 14)).toBe(true);
    expect(listMigrations(dir)).toEqual([first, second]);
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
