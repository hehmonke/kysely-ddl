import { describe, expect, test } from 'bun:test';

import { type AnyTable, AUTO_NAMES, defineTable, ref, renderSql, sql, toSnakeCase } from '../src/index.ts';

const userTable = defineTable({
  name: 'user',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    nickname: t.varchar({ length: 32 }).notNull(),
    email: t.varchar(),
    status: t.enum(['active', 'banned']).notNull(),
    legacyName: t.varchar('legacy'),
  }),
  primaryKey: { columns: ['id'] },
  uniques: [{ columns: ['email'] }],
  indexes: [{ unique: true, columns: ['nickname'], where: c => sql`${c.email} is not null` }],
  checks: [{ expression: c => sql`char_length(${c.nickname}) >= 2` }],
});

describe('toSnakeCase', () => {
  test('converts camelCase to snake_case', () => {
    expect(toSnakeCase('createdAt')).toBe('created_at');
    expect(toSnakeCase('appleId')).toBe('apple_id');
    expect(toSnakeCase('id')).toBe('id');
    expect(toSnakeCase('already_snake')).toBe('already_snake');
  });

  test('the first letter is lowercased, not prefixed with an underscore', () => {
    expect(toSnakeCase('UserId')).toBe('user_id');
  });

  test('consecutive capitals are not split, like CamelCasePlugin', () => {
    expect(toSnakeCase('appleID')).toBe('apple_id');
    expect(toSnakeCase('parseJSONValue')).toBe('parse_jsonvalue'); // the boundary after an acronym is lost, like the plugin
  });
});

describe('defineTable: columns', () => {
  test('the column name is derived from the property name', () => {
    expect(userTable.spec.columns.map(c => c.name)).toEqual(['id', 'created_at', 'nickname', 'email', 'status', 'legacy']);
  });

  test('an explicit name overrides the derived one', () => {
    expect(userTable.spec.columns.find(c => c.key === 'legacyName')?.name).toBe('legacy');
  });

  test('sqlType reflects the builder parameters', () => {
    const byKey = Object.fromEntries(userTable.spec.columns.map(c => [c.key, c]));
    expect(byKey.createdAt?.sqlType).toBe('timestamp with time zone');
    expect(byKey.nickname?.sqlType).toBe('varchar(32)');
    expect(byKey.email?.sqlType).toBe('varchar');
    expect(byKey.status?.sqlType).toBe('varchar');
  });

  test('enum() turns into a check on the values', () => {
    const check = userTable.spec.checks.find(c => c.name === 'user_status_check');
    expect(check).toBeDefined();
    expect(renderSql(check!.expression)).toBe(`"status" in ('active', 'banned')`);
  });

  test('two properties with the same database name are an error', () => {
    expect(() => defineTable({ name: 't', columns: t => ({ userId: t.uuid(), user_id: t.uuid() }) })).toThrow(
      /"user_id" is used twice/,
    );
  });

  test('enum().array() is not supported yet', () => {
    expect(() => defineTable({ name: 't', columns: t => ({ tags: t.enum(['a']).array() }) })).toThrow(
      /enum\(\)\.array\(\)/,
    );
  });

  test('enum() without values is an error', () => {
    expect(() => defineTable({ name: 't', columns: t => ({ s: t.enum([] as unknown as ['x']) }) })).toThrow(
      /non-empty list/,
    );
  });
});

describe('defineTable: auto-names', () => {
  test('the primary key is named without columns', () => {
    expect(userTable.spec.primaryKey?.name).toBe(`user_${AUTO_NAMES.primaryKey}`);
  });

  test('unique, index and check are built from the table and columns', () => {
    expect(userTable.spec.uniques.map(u => u.name)).toEqual(['user_email_uq']);
    expect(userTable.spec.indexes.map(i => i.name)).toEqual(['user_nickname_idx']);
    expect(userTable.spec.checks.map(c => c.name).toSorted()).toEqual(['user_nickname_check', 'user_status_check']);
  });

  test('a check name is built from the columns the expression references', () => {
    const table = defineTable({
      name: 'account',
      columns: t => ({ balance: t.numeric(), reserved: t.numeric() }),
      checks: [{ expression: c => sql`${c.reserved} <= ${c.balance}` }],
    });
    expect(table.spec.checks[0]?.name).toBe('account_reserved_balance_check');
  });

  test('a check with neither columns nor a name is an error', () => {
    expect(() =>
      defineTable({
        name: 't',
        columns: t => ({ a: t.integer() }),
        checks: [{ expression: () => sql`1 = 1` }],
      }),
    ).toThrow(/must reference at least one column/);
  });

  test('foreign key: name, columns and target resolve to database names', () => {
    const session = defineTable({
      name: 'session',
      columns: t => ({ id: t.uuid().notNull(), userId: t.uuid().notNull() }),
      primaryKey: { columns: ['id'] },
      foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
    });
    expect(session.spec.foreignKeys).toEqual([
      {
        name: 'session_user_id_fk',
        columns: ['user_id'],
        refTable: 'user',
        refColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: undefined,
      },
    ]);
  });

  test('a foreign key to a missing target column is a runtime error', () => {
    const target = userTable as AnyTable;
    expect(() =>
      defineTable({
        name: 'session',
        columns: t => ({ userId: t.uuid() }),
        foreignKeys: [{ columns: ['userId'], references: ref(target, ['nope']) }],
      }),
    ).toThrow(/has no column nope/);
  });

  test('a long auto-name is shortened to 63 bytes with a hash', () => {
    const table = defineTable({
      name: 'user_resource_reconciliation_snapshot',
      columns: t => ({ reconciliationBatchIdentifier: t.uuid(), resourceKind: t.varchar() }),
      indexes: [{ columns: ['reconciliationBatchIdentifier', 'resourceKind'] }],
    });
    const name = table.spec.indexes[0]!.name;
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    expect(name).toMatch(/_[0-9a-f]{8}$/);
    expect(name.startsWith('user_resource_reconciliation_snapshot_reconciliation_b')).toBe(true);
  });

  test('an explicit name over 63 bytes is an error', () => {
    expect(() =>
      defineTable({
        name: 't',
        columns: t => ({ a: t.integer() }),
        indexes: [{ name: 'i'.repeat(64), columns: ['a'] }],
      }),
    ).toThrow(/is 64 bytes long/);
  });

  test('two indexes on the same columns share an auto-name, which is an error', () => {
    expect(() =>
      defineTable({
        name: 't',
        columns: t => ({ a: t.integer() }),
        indexes: [{ columns: ['a'] }, { unique: true, columns: ['a'] }],
      }),
    ).toThrow(/index name "t_a_idx" is used twice/);
  });

  test('unique and check share one namespace', () => {
    expect(() =>
      defineTable({
        name: 't',
        columns: t => ({ a: t.integer() }),
        uniques: [{ columns: ['a'] }],
        checks: [{ name: 't_a_uq', expression: c => sql`${c.a} > 0` }],
      }),
    ).toThrow(/is taken twice/);
  });

  test('an index named like a unique constraint is an error', () => {
    expect(() =>
      defineTable({
        name: 't',
        columns: t => ({ a: t.integer() }),
        uniques: [{ columns: ['a'] }],
        indexes: [{ name: 't_a_uq', columns: ['a'] }],
      }),
    ).toThrow(/same name as the unique/);
  });
});

describe('defineTable: concurrently', () => {
  test('an index can ask to be built concurrently; by default it is not', () => {
    const table = defineTable({
      name: 't',
      columns: t => ({ a: t.integer(), b: t.integer() }),
      indexes: [{ columns: ['a'], concurrently: true }, { columns: ['b'] }],
    });

    expect(table.spec.indexes.map(index => [index.name, index.concurrently])).toEqual([
      ['t_a_idx', true],
      ['t_b_idx', false],
    ]);
  });
});
