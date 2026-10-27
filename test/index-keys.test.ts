import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { sql } from 'kysely';

import { buildSnapshot, type ColumnBuilders, defineTable, generateMigration, type TableOptions } from '../src/index.ts';

import { ADMIN_URL, createTempDatabase, query, type TempDatabase } from './helpers/database.ts';

const characterColumns = (t: ColumnBuilders) => ({
  id: t.uuid().notNull(),
  firstname: t.text().notNull(),
  friendA: t.uuid().notNull(),
  friendB: t.uuid().notNull(),
  permissions: t.int().array().notNull(),
  metadata: t.jsonb().notNull(),
  status: t.varchar().notNull(),
  createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
});

/** Every kind of index key at once: an operator class, expressions, a sort order, a method. */
const characterTable = defineTable({
  name: 'character',
  columns: characterColumns,
  primaryKey: { columns: ['id'] },
  indexes: [
    { name: 'character_firstname_trgm_idx', using: 'gin', columns: [{ column: 'firstname', opclass: 'gin_trgm_ops' }] },
    { using: 'gin', columns: ['permissions'] },
    {
      unique: true,
      columns: [
        { expression: c => sql`least(${c.friendA}, ${c.friendB})` },
        { expression: c => sql`greatest(${c.friendA}, ${c.friendB})` },
      ],
    },
    {
      columns: [{ expression: c => sql`${c.metadata} ->> 'vehicleId'` }, 'status'],
      where: c => sql`${c.metadata} ->> 'type' = 'vehicle'`,
    },
    { columns: ['status', { column: 'createdAt', order: 'desc' }] },
  ],
});

describe('index keys: snapshot', () => {
  const indexes = buildSnapshot([characterTable]).tables[0]?.indexes;

  test('a plain column stays a string, anything else is an object; btree has no `using`', () => {
    expect(indexes).toEqual([
      {
        name: 'character_firstname_trgm_idx',
        unique: false,
        using: 'gin',
        columns: [{ column: 'firstname', opclass: 'gin_trgm_ops' }],
        where: null,
        concurrently: false,
      },
      {
        name: 'character_permissions_idx',
        unique: false,
        using: 'gin',
        columns: ['permissions'],
        where: null,
        concurrently: false,
      },
      {
        name: 'character_friend_a_friend_b_idx',
        unique: true,
        columns: [{ expression: 'least("friend_a", "friend_b")' }, { expression: 'greatest("friend_a", "friend_b")' }],
        where: null,
        concurrently: false,
      },
      {
        name: 'character_metadata_status_idx',
        unique: false,
        columns: [{ expression: `"metadata" ->> 'vehicleId'` }, 'status'],
        where: `"metadata" ->> 'type' = 'vehicle'`,
        concurrently: false,
      },
      {
        name: 'character_status_created_at_idx',
        unique: false,
        columns: ['status', { column: 'created_at', order: 'desc' }],
        where: null,
        concurrently: false,
      },
    ]);
  });

  test('options equal to the postgres defaults are left out', () => {
    const spelledOut = defineTable({
      name: 't',
      columns: t => ({ a: t.int(), b: t.int() }),
      indexes: [
        {
          using: 'btree',
          columns: [
            { column: 'a', order: 'asc', nulls: 'last' },
            { column: 'b', order: 'desc', nulls: 'first' },
          ],
        },
      ],
    });

    expect(buildSnapshot([spelledOut]).tables[0]?.indexes[0]?.columns).toEqual(['a', { column: 'b', order: 'desc' }]);
    expect(buildSnapshot([spelledOut]).tables[0]?.indexes[0]).not.toHaveProperty('using');
  });

  test('a non-default nulls placement is kept', () => {
    const table = defineTable({
      name: 't',
      columns: t => ({ a: t.int() }),
      indexes: [{ columns: [{ column: 'a', nulls: 'first' }] }],
    });

    expect(buildSnapshot([table]).tables[0]?.indexes[0]?.columns).toEqual([{ column: 'a', nulls: 'first' }]);
  });
});

describe('index keys: SQL', () => {
  const result = generateMigration([characterTable]);

  test('USING, operator classes, expressions in parentheses, DESC', () => {
    expect(result.statements.slice(1)).toEqual([
      'CREATE INDEX "character_firstname_trgm_idx" ON "character" USING gin ("firstname" gin_trgm_ops);',
      'CREATE INDEX "character_permissions_idx" ON "character" USING gin ("permissions");',
      'CREATE UNIQUE INDEX "character_friend_a_friend_b_idx" ON "character" ' +
        '((least("friend_a", "friend_b")),(greatest("friend_a", "friend_b")));',
      `CREATE INDEX "character_metadata_status_idx" ON "character" (("metadata" ->> 'vehicleId'),"status") ` +
        `WHERE "metadata" ->> 'type' = 'vehicle';`,
      'CREATE INDEX "character_status_created_at_idx" ON "character" ("status","created_at" DESC);',
    ]);
  });

  test('NULLS is written when it differs from the default', () => {
    const table = defineTable({
      name: 't',
      columns: t => ({ a: t.int() }),
      indexes: [{ columns: [{ column: 'a', order: 'desc', nulls: 'last' }] }],
    });

    expect(generateMigration([table]).statements[1]).toBe('CREATE INDEX "t_a_idx" ON "t" ("a" DESC NULLS LAST);');
  });

  test('regenerating from the fresh snapshot yields no changes', () => {
    expect(generateMigration([characterTable], result.snapshot).changes).toEqual([]);
  });
});

const textColumns = (t: ColumnBuilders) => ({ a: t.text(), b: t.text() });

describe('index keys: diff', () => {
  const plain = defineTable({ name: 't', columns: textColumns, indexes: [{ columns: ['a'] }] });
  const before = buildSnapshot([plain]);

  const withIndex = (indexes: TableOptions<'t', ReturnType<typeof textColumns>>['indexes']) =>
    defineTable({ name: 't', columns: textColumns, indexes });

  test('spelling out btree and the default order is not a change', () => {
    const same = withIndex([{ using: 'btree', columns: [{ column: 'a', order: 'asc', nulls: 'last' }] }]);
    expect(generateMigration([same], before).changes).toEqual([]);
  });

  test('a new method, operator class or order replaces the index', () => {
    const variants = [
      withIndex([{ name: 't_a_idx', using: 'hash', columns: ['a'] }]),
      withIndex([{ name: 't_a_idx', columns: [{ column: 'a', opclass: 'text_pattern_ops' }] }]),
      withIndex([{ name: 't_a_idx', columns: [{ column: 'a', order: 'desc' }] }]),
    ];

    for (const variant of variants) {
      expect(generateMigration([variant], before).changes.map(change => change.kind)).toEqual(['dropIndex', 'createIndex']);
    }
  });

  test('an expression key that changes replaces the index', () => {
    const lower = withIndex([{ name: 't_a_idx', columns: [{ expression: c => sql`lower(${c.a})` }] }]);
    const upper = withIndex([{ name: 't_a_idx', columns: [{ expression: c => sql`upper(${c.a})` }] }]);

    expect(generateMigration([upper], buildSnapshot([lower])).statements).toEqual([
      'DROP INDEX "t_a_idx";',
      'CREATE INDEX "t_a_idx" ON "t" ((upper("a")));',
    ]);
  });

  test('a snapshot written before `using` existed reads as btree', () => {
    const old = JSON.parse(JSON.stringify(before)) as typeof before;
    expect(generateMigration([plain], old).changes).toEqual([]);
  });
});

const columns = (t: ColumnBuilders) => ({ a: t.int(), tags: t.int().array() });

describe('index keys: defineTable checks', () => {
  test('only btree can be unique', () => {
    expect(() =>
      defineTable({ name: 't', columns, indexes: [{ unique: true, using: 'gin', columns: ['tags'] }] }),
    ).toThrow(/only btree indexes can be unique, not gin/);
  });

  test('order and nulls need btree', () => {
    expect(() =>
      defineTable({ name: 't', columns, indexes: [{ using: 'gin', columns: [{ column: 'tags', order: 'desc' }] }] }),
    ).toThrow(/`order` and `nulls` need btree/);
  });

  test('an operator class must look like a name: it is written unquoted', () => {
    expect(() =>
      defineTable({ name: 't', columns, indexes: [{ columns: [{ column: 'a', opclass: 'int4_ops; drop table t' }] }] }),
    ).toThrow(/is not an operator class name/);
  });

  test('a key with both a column and an expression is an error', () => {
    const key = { column: 'a', expression: () => sql`1` } as unknown as 'a';
    expect(() => defineTable({ name: 't', columns, indexes: [{ columns: [key] }] })).toThrow(/exactly one of them/);
  });

  test('an unnamed index over an expression without columns is an error', () => {
    expect(() =>
      defineTable({ name: 't', columns, indexes: [{ columns: [{ expression: () => sql`now()` }] }] }),
    ).toThrow(/an index without a name must reference at least one column/);
  });

  test('an index needs at least one key', () => {
    expect(() => defineTable({ name: 't', columns, indexes: [{ name: 'empty_idx', columns: [] }] })).toThrow(
      /t: index empty_idx has no columns/,
    );
  });

  test('a method must be a name: it is written unquoted', () => {
    expect(() => defineTable({ name: 't', columns, indexes: [{ using: 'gin; drop table t', columns: ['tags'] }] })).toThrow(
      /is not an index method name/,
    );
  });

  test('a method an extension installs is accepted and left to postgres to judge', () => {
    const table = defineTable({
      name: 'doc',
      columns: t => ({ embedding: t.varchar().notNull(), a: t.int(), b: t.int() }),
      indexes: [
        { using: 'hnsw', columns: [{ column: 'embedding', opclass: 'vector_cosine_ops' }] },
        { using: 'bloom', columns: ['a', 'b'] },
      ],
    });

    expect(generateMigration([table]).statements.slice(1)).toEqual([
      'CREATE INDEX "doc_embedding_idx" ON "doc" USING hnsw ("embedding" vector_cosine_ops);',
      'CREATE INDEX "doc_a_b_idx" ON "doc" USING bloom ("a","b");',
    ]);
  });

  test('hash and spgist take one key; gist, gin and brin take several', () => {
    const two = (using: 'hash' | 'spgist' | 'gist' | 'gin' | 'brin') =>
      defineTable({ name: 't', columns, indexes: [{ using, columns: ['a', 'tags'] }] });

    expect(() => two('hash')).toThrow(/t: index t_a_tags_idx: hash indexes take one key, not 2/);
    expect(() => two('spgist')).toThrow(/spgist indexes take one key, not 2/);
    expect(() => two('gist')).not.toThrow();
    expect(() => two('gin')).not.toThrow();
    expect(() => two('brin')).not.toThrow();
  });

  test('plain columns name the index as before, repeats included; an expression adds only new columns', () => {
    const table = defineTable({
      name: 't',
      columns,
      indexes: [
        { columns: ['a', 'a'] },
        { columns: ['a', { expression: c => sql`${c.a} + ${c.tags}[1]` }] },
      ],
    });

    expect(table.spec.indexes.map(index => index.name)).toEqual(['t_a_a_idx', 't_a_tags_idx']);
  });

  test('a missing key column is reported like any other', () => {
    expect(() =>
      defineTable({ name: 't', columns, indexes: [{ columns: [{ column: 'nope' as 'a' }] }] }),
    ).toThrow(/t: no column nope/);
  });

  test('an expression that cannot be rendered is reported with the index name', () => {
    expect(() =>
      defineTable({
        name: 't',
        columns,
        indexes: [{ name: 'bad_idx', columns: [{ expression: c => sql`${c.a} + ${new Date(0)}` }] }],
      }),
    ).toThrow(/t: index bad_idx: cannot interpolate/);
  });
});

const describeDb = ADMIN_URL === undefined ? describe.skip : describe;

describeDb('index keys and new column types: postgres accepts the SQL', () => {
  let tempDb: TempDatabase;

  beforeEach(async () => {
    tempDb = await createTempDatabase();
  });

  afterEach(async () => {
    await tempDb.drop();
  });

  test('the indexes come out as declared', async () => {
    await query(tempDb.url, 'CREATE EXTENSION pg_trgm');
    await query(tempDb.url, generateMigration([characterTable]).sql);

    const rows = await query<{ indexdef: string }>(
      tempDb.url,
      `select indexdef from pg_indexes where tablename = 'character' and indexname <> 'character_pk' order by indexname`,
    );

    expect(rows.map(row => row.indexdef)).toEqual([
      'CREATE INDEX character_firstname_trgm_idx ON public."character" USING gin (firstname gin_trgm_ops)',
      'CREATE UNIQUE INDEX character_friend_a_friend_b_idx ON public."character" ' +
        'USING btree (LEAST(friend_a, friend_b), GREATEST(friend_a, friend_b))',
      `CREATE INDEX character_metadata_status_idx ON public."character" USING btree (((metadata ->> 'vehicleId'::text)), status) ` +
        `WHERE ((metadata ->> 'type'::text) = 'vehicle'::text)`,
      'CREATE INDEX character_permissions_idx ON public."character" USING gin (permissions)',
      'CREATE INDEX character_status_created_at_idx ON public."character" USING btree (status, created_at DESC)',
    ]);
  });

  test('text, smallint, double precision and a by-default identity', async () => {
    const counterTable = defineTable({
      name: 'counter',
      columns: t => ({
        id: t.int().generatedByDefaultAsIdentity(),
        kind: t.smallint().notNull(),
        label: t.text().notNull(),
        ratio: t.doublePrecision().notNull().default(0.5),
        seq: t.smallint().generatedAlwaysAsIdentity(),
      }),
      primaryKey: { columns: ['id'] },
    });

    await query(tempDb.url, generateMigration([counterTable]).sql);

    const columns = await query<{ column_name: string; data_type: string; identity_generation: string | null }>(
      tempDb.url,
      `select column_name, data_type, identity_generation from information_schema.columns
        where table_name = 'counter' order by ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: 'id', data_type: 'integer', identity_generation: 'BY DEFAULT' },
      { column_name: 'kind', data_type: 'smallint', identity_generation: null },
      { column_name: 'label', data_type: 'text', identity_generation: null },
      { column_name: 'ratio', data_type: 'double precision', identity_generation: null },
      { column_name: 'seq', data_type: 'smallint', identity_generation: 'ALWAYS' },
    ]);

    // a fixed id, as a seed writes it, and a generated one next to it
    await query(tempDb.url, `insert into counter (id, kind, label) values (100, 1, 'seed')`);
    await query(tempDb.url, `insert into counter (kind, label) values (2, 'generated')`);

    const rows = await query<{ id: number; kind: number; ratio: number }>(
      tempDb.url,
      'select id, kind, ratio from counter order by kind',
    );
    expect(rows).toEqual([
      { id: 100, kind: 1, ratio: 0.5 },
      { id: 1, kind: 2, ratio: 0.5 },
    ]);
  });

  test('an identity switched between ALWAYS and BY DEFAULT, on a live table', async () => {
    const always = defineTable({ name: 'seq', columns: t => ({ id: t.int().generatedAlwaysAsIdentity(), label: t.text() }) });
    const byDefault = defineTable({ name: 'seq', columns: t => ({ id: t.int().generatedByDefaultAsIdentity(), label: t.text() }) });
    const created = generateMigration([always]);

    await query(tempDb.url, created.sql);
    await expect(query(tempDb.url, `insert into seq (id, label) values (5, 'fixed')`)).rejects.toThrow(/non-DEFAULT value/);

    const relaxed = generateMigration([byDefault], created.snapshot);
    await query(tempDb.url, relaxed.sql);
    await query(tempDb.url, `insert into seq (id, label) values (5, 'fixed')`);

    await query(tempDb.url, generateMigration([always], relaxed.snapshot).sql);
    await expect(query(tempDb.url, `insert into seq (id, label) values (6, 'fixed')`)).rejects.toThrow(/non-DEFAULT value/);
  });
});
