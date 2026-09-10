import { describe, expect, test } from 'bun:test';

import {
  CamelCasePlugin,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';

import { toCamelCase, toSnakeCase } from '../src/index.ts';

/** Kysely without a connection: only the query compiler and the plugin are needed. */
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: kysely => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  plugins: [new CamelCasePlugin()],
});

const CAMEL = ['createdAt', 'appleID', 'fooBAR', 'URL', 'line2Total', 'parseJSONValue', 'id', 'UserId', 'x1Y2', 'a'];
const SNAKE = ['created_at', 'user_id', 'id', 'a__b', '_foo', 'field_2', 'foo_', 'apple_id', 'line2_total', 'kysely_migration'];

describe('toSnakeCase', () => {
  test('rewrites identifiers the same way CamelCasePlugin does', () => {
    for (const name of CAMEL) {
      const { sql } = db.selectFrom(name).select(name).compile();
      expect(sql).toBe(`select "${toSnakeCase(name)}" from "${toSnakeCase(name)}"`);
    }
  });

  test('consecutive capitals are not split, digits are left alone', () => {
    expect(toSnakeCase('appleID')).toBe('apple_id');
    expect(toSnakeCase('fooBAR')).toBe('foo_bar');
    expect(toSnakeCase('URL')).toBe('url');
    expect(toSnakeCase('line2Total')).toBe('line2_total');
    expect(toSnakeCase('UserId')).toBe('user_id');
    expect(toSnakeCase('')).toBe('');
  });
});

describe('toCamelCase', () => {
  test('renames row keys the same way CamelCasePlugin does', async () => {
    const plugin = new CamelCasePlugin();
    const row = Object.fromEntries(SNAKE.map(name => [name, 1]));
    const result = await plugin.transformResult({ result: { rows: [row] }, queryId: { queryId: 'test' } });

    expect(Object.keys(result.rows[0]!)).toEqual(SNAKE.map(toCamelCase));
  });

  test('names derived from schema properties round-trip without loss', () => {
    for (const name of ['createdAt', 'userId', 'line2Total', 'id', 'nickname']) {
      expect(toCamelCase(toSnakeCase(name))).toBe(name);
    }
  });

  test('known exceptions: consecutive capitals and an underscore before a digit', () => {
    expect(toCamelCase(toSnakeCase('appleID'))).toBe('appleId');
    expect(toSnakeCase(toCamelCase('field_2'))).toBe('field2');
  });
});
