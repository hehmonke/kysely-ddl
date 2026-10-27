import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  type AnyTable,
  buildSnapshot,
  type ColumnBuilders,
  defineForeignKey,
  defineTable,
  generateMigration,
  isForeignKey,
  isTable,
  ref,
  type SchemaObject,
  type TableOptions,
} from '../src/index.ts';

import { ADMIN_URL, createTempDatabase, query, type TempDatabase } from './helpers/database.ts';

// two tables with keys on each other: a fraction has a leader among its members,
// a member belongs to a fraction
const memberColumns = (t: ColumnBuilders) => ({ id: t.int().notNull(), fractionId: t.int().notNull() });

const member = (foreignKeys?: TableOptions<'fraction_member', ReturnType<typeof memberColumns>>['foreignKeys']) =>
  defineTable({ name: 'fraction_member', columns: memberColumns, primaryKey: { columns: ['id'] }, foreignKeys });

const memberTable = member();

const fractionTable = defineTable({
  name: 'fraction',
  columns: t => ({ id: t.int().notNull(), leaderId: t.int() }),
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['leaderId'], references: ref(memberTable, ['id']), onDelete: 'set null' }],
});

const memberFractionFk = defineForeignKey(memberTable, {
  columns: ['fractionId'],
  references: ref(fractionTable, ['id']),
  onDelete: 'cascade',
});

const memberKeyNames = (schema: readonly SchemaObject[]) =>
  buildSnapshot(schema).tables.find(table => table.name === 'fraction_member')?.foreignKeys.map(fk => fk.name);

describe('defineForeignKey', () => {
  test('is resolved like a key in defineTable: database names and the auto-name', () => {
    expect(memberFractionFk.spec).toEqual({
      name: 'fraction_member_fraction_id_fk',
      columns: ['fraction_id'],
      refTable: 'fraction',
      refColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: undefined,
    });
    expect(memberFractionFk.table).toBe(memberTable);
  });

  test('is a foreign key and not a table, and a table is not a foreign key', () => {
    expect(isForeignKey(memberFractionFk)).toBe(true);
    expect(isTable(memberFractionFk)).toBe(false);
    expect(isForeignKey(memberTable)).toBe(false);
    expect(isForeignKey({ table: memberTable, spec: memberFractionFk.spec })).toBe(false);
  });

  test('goes into its table: the same snapshot and SQL as the key inside defineTable', () => {
    const inside = member([{ columns: ['fractionId'], references: ref(fractionTable, ['id']), onDelete: 'cascade' }]);

    expect(buildSnapshot([fractionTable, memberTable, memberFractionFk])).toEqual(buildSnapshot([fractionTable, inside]));
    expect(generateMigration([memberFractionFk, memberTable, fractionTable]).sql).toBe(
      generateMigration([fractionTable, inside]).sql,
    );
  });

  test('both keys of the cycle come after both CREATE TABLEs', () => {
    expect(generateMigration([fractionTable, memberTable, memberFractionFk]).statements.slice(2)).toEqual([
      'ALTER TABLE "fraction" ADD CONSTRAINT "fraction_leader_id_fk" FOREIGN KEY ("leader_id") ' +
        'REFERENCES "fraction_member"("id") ON DELETE SET NULL;',
      'ALTER TABLE "fraction_member" ADD CONSTRAINT "fraction_member_fraction_id_fk" FOREIGN KEY ("fraction_id") ' +
        'REFERENCES "fraction"("id") ON DELETE CASCADE;',
    ]);
  });

  test('moved between defineTable and defineForeignKey under the same name: no changes', () => {
    const named = { name: 'member_fraction', columns: ['fractionId'] as const, references: ref(fractionTable, ['id']) };
    const inside = [fractionTable, member([named])];
    const outside = [fractionTable, memberTable, defineForeignKey(memberTable, named)];

    expect(generateMigration(outside, buildSnapshot(inside)).changes).toEqual([]);
    expect(generateMigration(inside, buildSnapshot(outside)).changes).toEqual([]);
    expect(generateMigration(outside, buildSnapshot([fractionTable, memberTable, memberFractionFk])).statements).toEqual([
      'ALTER TABLE "fraction_member" DROP CONSTRAINT "fraction_member_fraction_id_fk";',
      'ALTER TABLE "fraction_member" ADD CONSTRAINT "member_fraction" FOREIGN KEY ("fraction_id") REFERENCES "fraction"("id");',
    ]);
  });

  test('added to an existing table: ADD CONSTRAINT; removed: DROP CONSTRAINT', () => {
    const without = buildSnapshot([fractionTable, memberTable]);
    const withKey = buildSnapshot([fractionTable, memberTable, memberFractionFk]);

    expect(generateMigration([fractionTable, memberTable, memberFractionFk], without).statements).toEqual([
      'ALTER TABLE "fraction_member" ADD CONSTRAINT "fraction_member_fraction_id_fk" FOREIGN KEY ("fraction_id") ' +
        'REFERENCES "fraction"("id") ON DELETE CASCADE;',
    ]);
    expect(generateMigration([fractionTable, memberTable], withKey).statements).toEqual([
      'ALTER TABLE "fraction_member" DROP CONSTRAINT "fraction_member_fraction_id_fk";',
    ]);
  });

  test('keys of one table are ordered by name, whatever order they are passed in', () => {
    const b = defineForeignKey(memberTable, { name: 'b_fk', columns: ['fractionId'], references: ref(fractionTable, ['id']) });
    const a = defineForeignKey(memberTable, { name: 'a_fk', columns: ['fractionId'], references: ref(fractionTable, ['id']) });
    expect(memberKeyNames([b, fractionTable, a, memberTable])).toEqual(['a_fk', 'b_fk']);
    expect(memberKeyNames([memberTable, a, b, fractionTable])).toEqual(['a_fk', 'b_fk']);
  });

  test('an auto-name over 63 bytes is shortened as in defineTable', () => {
    const long = 'a_column_name_long_enough_to_push_the_key_name_over_the_limit';
    const columns = (t: ColumnBuilders) => ({ [long]: t.int() });
    const outside = defineTable({ name: 'fraction_member', columns });
    const inside = defineTable({
      name: 'fraction_member',
      columns,
      foreignKeys: [{ columns: [long], references: ref(fractionTable, ['id']) }],
    });
    const key = defineForeignKey(outside, { columns: [long], references: ref(fractionTable, ['id']) });

    expect(Buffer.byteLength(key.spec.name)).toBeLessThanOrEqual(63);
    expect(key.spec.name).toBe(inside.spec.foreignKeys[0]?.name ?? '');
  });

  test('an explicit name over 63 bytes is an error', () => {
    expect(() =>
      defineForeignKey(memberTable, { name: 'x'.repeat(64), columns: ['fractionId'], references: ref(fractionTable, ['id']) }),
    ).toThrow(/^fraction_member: foreign key: .*64 bytes long/);
  });

  test('a missing column on either side is an error', () => {
    expect(() =>
      defineForeignKey(memberTable, { columns: ['nope' as 'id'], references: ref(fractionTable, ['id']) }),
    ).toThrow('fraction_member: no column nope');
    expect(() =>
      defineForeignKey(memberTable, { columns: ['fractionId'], references: ref(fractionTable, ['nope' as 'id']) }),
    ).toThrow('fraction_member: table fraction has no column nope');
  });

  test('a name the table already has is an error where the key is declared', () => {
    expect(() =>
      defineForeignKey(memberTable, { name: 'fraction_member_pk', columns: ['fractionId'], references: ref(fractionTable, ['id']) }),
    ).toThrow(/fraction_member: name "fraction_member_pk" is taken twice, as primary key and as foreign key/);

    const inside = member([{ columns: ['fractionId'], references: ref(fractionTable, ['id']) }]);

    expect(() => defineForeignKey(inside, { columns: ['fractionId'], references: ref(fractionTable, ['id']) })).toThrow(
      /name "fraction_member_fraction_id_fk" is taken twice, twice as foreign key/,
    );
  });

  test('two keys outside the table under one name are an error of the generator', () => {
    const again = defineForeignKey(memberTable, { columns: ['fractionId'], references: ref(fractionTable, ['id']) });

    expect(() => buildSnapshot([fractionTable, memberTable, memberFractionFk, again])).toThrow(
      /fraction_member: name "fraction_member_fraction_id_fk" is taken twice/,
    );
    expect(() => buildSnapshot([fractionTable, memberTable, memberFractionFk, memberFractionFk])).toThrow(
      'foreign key "fraction_member_fraction_id_fk" is passed twice',
    );
  });

  test('its table missing from the list is an error, and so is another definition of it', () => {
    expect(() => generateMigration([fractionTable, memberFractionFk])).toThrow(
      'foreign key "fraction_member_fraction_id_fk" belongs to table "fraction_member", which is not among the tables passed',
    );
    expect(() => generateMigration([fractionTable, member(), memberFractionFk])).toThrow(
      'foreign key "fraction_member_fraction_id_fk" belongs to another definition of table "fraction_member" than the one passed',
    );
  });

  test('a table that is undefined, as an import cycle leaves it, is named in the error', () => {
    const loading = undefined as unknown as AnyTable;

    expect(() => ref(loading, [])).toThrow(/^ref: expected a table, got undefined\. .*defineForeignKey/);
    expect(() => defineForeignKey(loading, { columns: [], references: ref(fractionTable, ['id']) })).toThrow(
      /^defineForeignKey: expected a table, got undefined/,
    );
  });
});

const describeDb = ADMIN_URL === undefined ? describe.skip : describe;

describeDb('defineForeignKey: postgres accepts the SQL', () => {
  let tempDb: TempDatabase;

  beforeEach(async () => {
    tempDb = await createTempDatabase();
  });

  afterEach(async () => {
    await tempDb.drop();
  });

  test('two tables with keys on each other are created, and both keys hold', async () => {
    await query(tempDb.url, generateMigration([memberFractionFk, fractionTable, memberTable]).sql);

    await query(tempDb.url, 'insert into fraction (id) values (1)');
    await query(tempDb.url, 'insert into fraction_member (id, fraction_id) values (10, 1)');
    await query(tempDb.url, 'update fraction set leader_id = 10 where id = 1');

    await expect(query(tempDb.url, 'insert into fraction_member (id, fraction_id) values (11, 2)')).rejects.toThrow(
      /fraction_member_fraction_id_fk/,
    );
    await expect(query(tempDb.url, 'update fraction set leader_id = 99 where id = 1')).rejects.toThrow(
      /fraction_leader_id_fk/,
    );

    const rules = await query<{ constraint_name: string; delete_rule: string }>(
      tempDb.url,
      `select constraint_name, delete_rule from information_schema.referential_constraints order by constraint_name`,
    );
    expect(rules).toEqual([
      { constraint_name: 'fraction_leader_id_fk', delete_rule: 'SET NULL' },
      { constraint_name: 'fraction_member_fraction_id_fk', delete_rule: 'CASCADE' },
    ]);

    // the cascade removes the members, and with them the leader the fraction points at
    await query(tempDb.url, 'delete from fraction where id = 1');
    expect(await query(tempDb.url, 'select id from fraction_member')).toEqual([]);
  });

  test('the key added to existing tables later applies too', async () => {
    await query(tempDb.url, generateMigration([fractionTable, memberTable]).sql);
    const later = generateMigration([fractionTable, memberTable, memberFractionFk], buildSnapshot([fractionTable, memberTable]));

    await query(tempDb.url, later.sql);

    expect(
      await query(tempDb.url, `select conname from pg_constraint where conrelid = 'fraction_member'::regclass and contype = 'f'`),
    ).toEqual([{ conname: 'fraction_member_fraction_id_fk' }]);
  });
});
