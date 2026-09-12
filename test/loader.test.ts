import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadTables } from '../src/index.ts';
import { globFiles } from '../src/loader/glob.ts';

let dir: string;

/** The package itself, so that a generated fixture can import `defineTable`. */
const SRC = JSON.stringify(new URL('../src/index.ts', import.meta.url).href);

const write = (relative: string, content: string): string => {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);

  return file.replaceAll('\\', '/');
};

/** A file exporting one table, plus whatever extra source is passed in. */
const tableFile = (name: string, extra = ''): string =>
  `import { defineTable } from ${SRC};\n${extra}\n` +
  `export const ${name}Table = defineTable({\n` +
  `  name: '${name}',\n` +
  '  columns: t => ({ id: t.uuid().notNull() }),\n' +
  "  primaryKey: { columns: ['id'] },\n" +
  '});\n';

const names = async (patterns: string | readonly string[]): Promise<string[]> =>
  (await loadTables(patterns, { cwd: dir })).map(table => table.spec.name);

beforeEach(() => {
  // realpath: on macOS the temp dir is a symlink, and the matched paths are real ones
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kysely-ddl-loader-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('globFiles', () => {
  test('`**` crosses directories, the last segment filters by name', () => {
    const a = write('src/tables/user.table.ts', '');
    const b = write('src/tables/billing/invoice.table.ts', '');
    write('src/tables/helpers.ts', '');
    write('src/tables/user.table.js', '');

    expect(globFiles(['src/tables/**/*.table.ts'], dir)).toEqual([b, a].toSorted());
  });

  test('absolute paths with forward slashes, sorted, without duplicates', () => {
    const a = write('src/a.table.ts', '');
    const b = write('src/b.table.ts', '');

    const files = globFiles(['src/*.table.ts', 'src/**/*.ts'], dir);

    expect(files).toEqual([a, b]);
    expect(files.every(file => path.isAbsolute(file) && !file.includes('\\'))).toBe(true);
  });

  test('`*` stays inside one segment', () => {
    write('src/deep/user.table.ts', '');
    const flat = write('src/user.table.ts', '');

    expect(globFiles(['src/*.table.ts'], dir)).toEqual([flat]);
  });

  test('`**` skips node_modules and dot-directories', () => {
    const own = write('src/user.table.ts', '');
    write('src/node_modules/pkg/evil.table.ts', '');
    write('src/.cache/old.table.ts', '');

    expect(globFiles(['src/**/*.table.ts'], dir)).toEqual([own]);
  });

  test('a directory named explicitly is reached even when it starts with a dot', () => {
    const hidden = write('.generated/user.table.ts', '');

    expect(globFiles(['.generated/*.table.ts'], dir)).toEqual([hidden]);
  });

  test('{a,b} expands, across segments too', () => {
    const ts = write('src/user.table.ts', '');
    const tsx = write('src/user.table.tsx', '');
    const other = write('other/user.table.ts', '');

    expect(globFiles(['src/*.table.{ts,tsx}'], dir)).toEqual([ts, tsx].toSorted());
    expect(globFiles(['{src,other}/*.table.ts'], dir)).toEqual([ts, other].toSorted());
  });

  test('`?` matches one character', () => {
    const one = write('src/v1.table.ts', '');
    write('src/v10.table.ts', '');

    expect(globFiles(['src/v?.table.ts'], dir)).toEqual([one]);
  });

  test('a `!` pattern excludes, whatever its place in the list', () => {
    const kept = write('src/user.table.ts', '');
    write('src/user.test.table.ts', '');

    expect(globFiles(['!src/*.test.table.ts', 'src/*.table.ts'], dir)).toEqual([kept]);
  });

  test('`..` and absolute patterns resolve', () => {
    const file = write('src/user.table.ts', '');

    expect(globFiles(['../src/*.table.ts'], path.join(dir, 'src'))).toEqual([file]);
    expect(globFiles([`${dir.replaceAll('\\', '/')}/src/*.table.ts`], process.cwd())).toEqual([file]);
  });

  test('a trailing `**` is everything below', () => {
    const a = write('src/user.table.ts', '');
    const b = write('src/deep/invoice.table.ts', '');

    expect(globFiles(['src/**'], dir)).toEqual([b, a].toSorted());
  });

  test('a missing directory is no match, not an error', () => {
    expect(globFiles(['nowhere/**/*.ts'], dir)).toEqual([]);
  });

  test('directories are not returned, only files', () => {
    write('src/tables/user.table.ts', '');

    expect(globFiles(['src/*'], dir)).toEqual([]);
  });
});

describe('loadTables', () => {
  test('collects the tables of every matched file, sorted by table name', async () => {
    write('src/tables/user.table.ts', tableFile('user'));
    write('src/tables/billing/invoice.table.ts', tableFile('invoice'));
    write('src/tables/notes.md', 'not a schema');

    expect(await names('src/tables/**/*.table.ts')).toEqual(['invoice', 'user']);
  });

  test('takes a single pattern or a list, and excludes with `!`', async () => {
    write('src/user.table.ts', tableFile('user'));
    write('src/fixture.table.ts', tableFile('fixture'));

    expect(await names(['src/*.table.ts', '!src/fixture.table.ts'])).toEqual(['user']);
  });

  test('a table re-exported from a barrel is counted once', async () => {
    write('src/user.table.ts', tableFile('user'));
    write('src/index.table.ts', "export * from './user.table.ts';\n");

    expect(await names('src/*.table.ts')).toEqual(['user']);
  });

  test('exports that are not tables are ignored', async () => {
    write('src/user.table.ts', `${tableFile('user')}export const config = { name: 'user', spec: {} };\n`);

    expect(await names('src/*.table.ts')).toEqual(['user']);
  });

  test('the result feeds generateMigration', async () => {
    write('src/user.table.ts', tableFile('user'));
    const { generateMigration } = await import('../src/index.ts');

    const result = generateMigration(await loadTables('src/*.table.ts', { cwd: dir }));

    expect(result.sql).toContain('CREATE TABLE "user"');
  });

  test('nothing matched is an error: a too-narrow glob would drop tables', async () => {
    write('src/user.table.ts', tableFile('user'));

    await expect(loadTables('src/**/*.schema.ts', { cwd: dir })).rejects.toThrow(/nothing matches "src\/\*\*\/\*\.schema\.ts"/);
  });

  test('files matched but no table exported is an error', async () => {
    write('src/user.table.ts', 'export const x = 1;\n');

    await expect(loadTables('src/*.table.ts', { cwd: dir })).rejects.toThrow(/none of them exports a table/);
  });

  test('only `!` patterns is an error', async () => {
    await expect(loadTables('!src/*.ts', { cwd: dir })).rejects.toThrow(/only excludes/);
    await expect(loadTables([], { cwd: dir })).rejects.toThrow(/no patterns/);
  });

  test('two tables with the same database name name both files', async () => {
    write('src/a.table.ts', tableFile('user'));
    write('src/b.table.ts', tableFile('user').replace('userTable', 'otherTable'));

    await expect(loadTables('src/*.table.ts', { cwd: dir })).rejects.toThrow(
      /two different tables are named "user".*a\.table\.ts.*b\.table\.ts/s,
    );
  });

  test('a foreign key to a table outside the match is an error', async () => {
    write(
      'src/user.table.ts',
      `import { defineTable } from ${SRC};\n` +
        "export const userTable = defineTable({ name: 'user', columns: t => ({ id: t.uuid().notNull() }), " +
        "primaryKey: { columns: ['id'] } });\n",
    );
    write(
      'src/session.entity.ts',
      `import { defineTable, ref } from ${SRC};\n` +
        "import { userTable } from './user.table.ts';\n" +
        "export const sessionTable = defineTable({ name: 'session', " +
        'columns: t => ({ id: t.uuid().notNull(), userId: t.uuid().notNull() }), ' +
        "primaryKey: { columns: ['id'] }, " +
        "foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']) }] });\n",
    );

    await expect(loadTables('src/*.entity.ts', { cwd: dir })).rejects.toThrow(
      /"session".*references "user".*none of the matched files exports/s,
    );
  });

  test('a file that fails to import is reported with its path', async () => {
    write('src/broken.table.ts', 'export const x = (;\n');

    await expect(loadTables('src/*.table.ts', { cwd: dir })).rejects.toThrow(/cannot import .*broken\.table\.ts/);
  });
});
