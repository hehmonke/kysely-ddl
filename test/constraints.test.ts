import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  buildSnapshot,
  type ColumnBuilders,
  defineTable,
  generateMigration,
  ref,
  type TableOptions,
} from '../src/index.ts';

import { ADMIN_URL, createTempDatabase, query, type TempDatabase } from './helpers/database.ts';

const ticketColumns = (t: ColumnBuilders) => ({
  id: t.int().notNull(),
  number: t.varchar().notNull(),
  locale: t.varchar().notNull(),
});

const ticket = (uniques: TableOptions<'ticket', ReturnType<typeof ticketColumns>>['uniques']) =>
  defineTable({ name: 'ticket', columns: ticketColumns, primaryKey: { columns: ['id'] }, uniques });

describe('unique constraints', () => {
  test('a new table gets them inside CREATE TABLE, after the primary key', () => {
    const table = ticket([{ columns: ['number'] }, { name: 'ticket_locale_number_key', columns: ['locale', 'number'] }]);

    expect(generateMigration([table]).sql).toBe(`CREATE TABLE "ticket" (
\t"id" integer NOT NULL,
\t"number" varchar NOT NULL,
\t"locale" varchar NOT NULL,
\tCONSTRAINT "ticket_pk" PRIMARY KEY("id"),
\tCONSTRAINT "ticket_number_uq" UNIQUE("number"),
\tCONSTRAINT "ticket_locale_number_key" UNIQUE("locale","number")
);
`);
  });

  test('the snapshot records the name and the columns in order', () => {
    const table = ticket([{ columns: ['locale', 'number'] }]);

    expect(buildSnapshot([table]).tables[0]?.uniques).toEqual([
      { name: 'ticket_locale_number_uq', columns: ['locale', 'number'] },
    ]);
  });

  test('added to an existing table: ADD CONSTRAINT', () => {
    const result = generateMigration([ticket([{ columns: ['number'] }])], buildSnapshot([ticket([])]));

    expect(result.statements).toEqual(['ALTER TABLE "ticket" ADD CONSTRAINT "ticket_number_uq" UNIQUE("number");']);
  });

  test('dropped: DROP CONSTRAINT', () => {
    const result = generateMigration([ticket([])], buildSnapshot([ticket([{ columns: ['number'] }])]));

    expect(result.statements).toEqual(['ALTER TABLE "ticket" DROP CONSTRAINT "ticket_number_uq";']);
  });

  test('the same name over other columns: replaced in one ALTER', () => {
    const before = buildSnapshot([ticket([{ name: 'ticket_code_uq', columns: ['number'] }])]);
    const result = generateMigration([ticket([{ name: 'ticket_code_uq', columns: ['locale', 'number'] }])], before);

    expect(result.statements).toEqual([
      'ALTER TABLE "ticket" DROP CONSTRAINT "ticket_code_uq", ADD CONSTRAINT "ticket_code_uq" UNIQUE("locale","number");',
    ]);
  });

  test('the same columns in another order are another constraint', () => {
    const before = buildSnapshot([ticket([{ name: 'ticket_code_uq', columns: ['locale', 'number'] }])]);
    const result = generateMigration([ticket([{ name: 'ticket_code_uq', columns: ['number', 'locale'] }])], before);

    expect(result.changes.map(change => change.kind)).toEqual(['replaceConstraint']);
  });

  test('unchanged: no changes', () => {
    const table = ticket([{ columns: ['number'] }]);

    expect(generateMigration([table], buildSnapshot([table])).changes).toEqual([]);
  });

  test('a unique turning into the primary key under the same name is a replace', () => {
    const asUnique = defineTable({
      name: 'ticket',
      columns: ticketColumns,
      uniques: [{ name: 'ticket_key', columns: ['id'] }],
    });
    const asPrimaryKey = defineTable({
      name: 'ticket',
      columns: ticketColumns,
      primaryKey: { name: 'ticket_key', columns: ['id'] },
    });

    expect(generateMigration([asPrimaryKey], buildSnapshot([asUnique])).statements).toEqual([
      'ALTER TABLE "ticket" DROP CONSTRAINT "ticket_key", ADD CONSTRAINT "ticket_key" PRIMARY KEY("id");',
    ]);
  });
});

const userTable = defineTable({
  name: 'user',
  columns: t => ({ id: t.int().notNull(), login: t.varchar().notNull() }),
  primaryKey: { columns: ['id'] },
  uniques: [{ columns: ['login'] }],
});

const sessionColumns = (t: ColumnBuilders) => ({ id: t.int().notNull(), userLogin: t.varchar() });

const session = (foreignKeys: TableOptions<'session', ReturnType<typeof sessionColumns>>['foreignKeys']) =>
  defineTable({ name: 'session', columns: sessionColumns, primaryKey: { columns: ['id'] }, foreignKeys });

describe('foreign keys: ON UPDATE', () => {
  test('ON DELETE and ON UPDATE together, in that order', () => {
    const table = session([
      { columns: ['userLogin'], references: ref(userTable, ['login']), onDelete: 'set null', onUpdate: 'cascade' },
    ]);

    expect(generateMigration([userTable, table]).statements.at(-1)).toBe(
      'ALTER TABLE "session" ADD CONSTRAINT "session_user_login_fk" FOREIGN KEY ("user_login") ' +
        'REFERENCES "user"("login") ON DELETE SET NULL ON UPDATE CASCADE;',
    );
  });

  test('ON UPDATE alone', () => {
    const table = session([{ columns: ['userLogin'], references: ref(userTable, ['login']), onUpdate: 'no action' }]);

    expect(generateMigration([userTable, table]).statements.at(-1)).toBe(
      'ALTER TABLE "session" ADD CONSTRAINT "session_user_login_fk" FOREIGN KEY ("user_login") ' +
        'REFERENCES "user"("login") ON UPDATE NO ACTION;',
    );
  });

  test('every action is written in upper case', () => {
    const actions = ['cascade', 'restrict', 'no action', 'set null', 'set default'] as const;

    for (const onUpdate of actions) {
      const table = session([{ columns: ['userLogin'], references: ref(userTable, ['login']), onUpdate }]);

      expect(generateMigration([userTable, table]).statements.at(-1)).toEndWith(` ON UPDATE ${onUpdate.toUpperCase()};`);
    }
  });

  test('a changed ON UPDATE replaces the foreign key', () => {
    const restrict = session([{ columns: ['userLogin'], references: ref(userTable, ['login']), onUpdate: 'restrict' }]);
    const cascade = session([{ columns: ['userLogin'], references: ref(userTable, ['login']), onUpdate: 'cascade' }]);

    expect(generateMigration([userTable, cascade], buildSnapshot([userTable, restrict])).statements).toEqual([
      'ALTER TABLE "session" DROP CONSTRAINT "session_user_login_fk", ADD CONSTRAINT "session_user_login_fk" ' +
        'FOREIGN KEY ("user_login") REFERENCES "user"("login") ON UPDATE CASCADE;',
    ]);
  });

  test('dropping ON UPDATE replaces it too', () => {
    const cascade = session([{ columns: ['userLogin'], references: ref(userTable, ['login']), onUpdate: 'cascade' }]);
    const plain = session([{ columns: ['userLogin'], references: ref(userTable, ['login']) }]);

    expect(generateMigration([userTable, plain], buildSnapshot([userTable, cascade])).changes.map(c => c.kind)).toEqual([
      'replaceConstraint',
    ]);
  });
});

const describeDb = ADMIN_URL === undefined ? describe.skip : describe;

describeDb('unique, ON UPDATE, boolean and numeric: postgres accepts the SQL', () => {
  let tempDb: TempDatabase;

  beforeEach(async () => {
    tempDb = await createTempDatabase();
  });

  afterEach(async () => {
    await tempDb.drop();
  });

  test('UNIQUE rejects a duplicate and ON UPDATE CASCADE follows the key', async () => {
    const sessionTable = session([
      { columns: ['userLogin'], references: ref(userTable, ['login']), onDelete: 'set null', onUpdate: 'cascade' },
    ]);

    await query(tempDb.url, generateMigration([userTable, sessionTable]).sql);
    await query(tempDb.url, `insert into "user" (id, login) values (1, 'neo')`);
    await query(tempDb.url, `insert into session (id, user_login) values (1, 'neo')`);

    await expect(query(tempDb.url, `insert into "user" (id, login) values (2, 'neo')`)).rejects.toThrow(/user_login_uq/);

    await query(tempDb.url, `update "user" set login = 'trinity' where id = 1`);
    expect(await query(tempDb.url, 'select user_login from session')).toEqual([{ user_login: 'trinity' }]);

    const rules = await query<{ update_rule: string; delete_rule: string }>(
      tempDb.url,
      `select update_rule, delete_rule from information_schema.referential_constraints
        where constraint_name = 'session_user_login_fk'`,
    );
    expect(rules).toEqual([{ update_rule: 'CASCADE', delete_rule: 'SET NULL' }]);
  });

  test('boolean and numeric come out as declared', async () => {
    const amounts = defineTable({
      name: 'amounts',
      columns: t => ({
        precise: t.numeric({ precision: 20 }).notNull(),
        scaled: t.numeric({ precision: 10, scale: 2 }).notNull(),
        active: t.boolean().notNull().default(false),
      }),
    });

    await query(tempDb.url, generateMigration([amounts]).sql);

    const columns = await query<{ column_name: string; data_type: string; numeric_precision: number | null; numeric_scale: number | null; column_default: string | null }>(
      tempDb.url,
      `select column_name, data_type, numeric_precision, numeric_scale, column_default from information_schema.columns
        where table_name = 'amounts' order by ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: 'precise', data_type: 'numeric', numeric_precision: 20, numeric_scale: 0, column_default: null },
      { column_name: 'scaled', data_type: 'numeric', numeric_precision: 10, numeric_scale: 2, column_default: null },
      { column_name: 'active', data_type: 'boolean', numeric_precision: null, numeric_scale: null, column_default: 'false' },
    ]);

    // numeric(20) has no fraction: postgres rounds it away
    await query(tempDb.url, `insert into amounts (precise, scaled) values (12345678901234567890.6, 1.005)`);
    expect(await query(tempDb.url, 'select precise, scaled, active from amounts')).toEqual([
      { precise: '12345678901234567891', scaled: '1.01', active: false },
    ]);
  });
});
