import { describe, expect, test } from 'bun:test';

import {
  buildSnapshot,
  defineTable,
  diffSnapshots,
  EMPTY_SNAPSHOT,
  generateMigration,
  ref,
  renderChanges,
  sql,
} from '../src/index.ts';

const userTable = defineTable({
  tableName: 'user',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
    nickname: t.varchar().notNull(),
    email: t.varchar(),
    status: t.enum(['active', 'banned']).notNull(),
  }),
  primaryKey: { columns: ['id'] },
  indexes: [{ unique: true, columns: ['nickname'] }],
  checks: [{ expression: c => sql`char_length(${c.nickname}) >= 2` }],
});

const sessionTable = defineTable({
  tableName: 'session',
  columns: t => ({
    id: t.uuid().notNull().default(sql`gen_random_uuid()`),
    userId: t.uuid().notNull(),
    seq: t.integer().generatedAlwaysAsIdentity(),
  }),
  primaryKey: { columns: ['id'] },
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']), onDelete: 'cascade' }],
});

describe('buildSnapshot', () => {
  test('captures the whole table; defaults and expressions as rendered SQL', () => {
    const snapshot = buildSnapshot([userTable]);
    expect(snapshot.version).toBe(1);
    expect(snapshot.tables[0]).toEqual({
      name: 'user',
      columns: [
        { name: 'id', type: 'uuid', notNull: true, default: 'gen_random_uuid()', identity: null },
        { name: 'created_at', type: 'timestamp with time zone', notNull: true, default: 'now()', identity: null },
        { name: 'nickname', type: 'varchar', notNull: true, default: null, identity: null },
        { name: 'email', type: 'varchar', notNull: false, default: null, identity: null },
        { name: 'status', type: 'varchar', notNull: true, default: null, identity: null },
      ],
      primaryKey: { name: 'user_pk', columns: ['id'] },
      uniques: [],
      indexes: [{ name: 'user_nickname_idx', unique: true, columns: ['nickname'], where: null }],
      foreignKeys: [],
      checks: [
        { name: 'user_status_check', expression: `"status" in ('active', 'banned')` },
        { name: 'user_nickname_check', expression: 'char_length("nickname") >= 2' },
      ],
    });
  });

  test('an array shows up in the type as `[]`', () => {
    const table = defineTable({ tableName: 't', columns: t => ({ tags: t.varchar().array() }) });
    expect(buildSnapshot([table]).tables[0]?.columns[0]?.type).toBe('varchar[]');
  });

  test('a table declared twice is an error', () => {
    expect(() => buildSnapshot([userTable, userTable])).toThrow(/declared twice/);
  });
});

describe('generateMigration: from scratch', () => {
  const result = generateMigration([userTable, sessionTable]);

  test('CREATE TABLE with pk/check inside, indexes and fks as separate statements at the end', () => {
    expect(result.sql).toBe(`CREATE TABLE "user" (
\t"id" uuid DEFAULT gen_random_uuid() NOT NULL,
\t"created_at" timestamp with time zone DEFAULT now() NOT NULL,
\t"nickname" varchar NOT NULL,
\t"email" varchar,
\t"status" varchar NOT NULL,
\tCONSTRAINT "user_pk" PRIMARY KEY("id"),
\tCONSTRAINT "user_status_check" CHECK ("status" in ('active', 'banned')),
\tCONSTRAINT "user_nickname_check" CHECK (char_length("nickname") >= 2)
);

CREATE TABLE "session" (
\t"id" uuid DEFAULT gen_random_uuid() NOT NULL,
\t"user_id" uuid NOT NULL,
\t"seq" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
\tCONSTRAINT "session_pk" PRIMARY KEY("id")
);

CREATE UNIQUE INDEX "user_nickname_idx" ON "user" ("nickname");
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;
`);
  });

  test('statements are the same SQL one by one', () => {
    expect(result.statements).toHaveLength(4);
    expect(result.statements[0]).toStartWith('CREATE TABLE "user"');
    expect(result.statements[2]).toBe('CREATE UNIQUE INDEX "user_nickname_idx" ON "user" ("nickname");');
    expect(result.statements[3]).toStartWith('ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fk"');
  });

  test('regenerating from the fresh snapshot yields no changes', () => {
    const again = generateMigration([userTable, sessionTable], result.snapshot);
    expect(again.sql).toBe('');
    expect(again.changes).toEqual([]);
    expect(again.statements).toEqual([]);
  });
});

describe('diffSnapshots: order and kinds of changes', () => {
  const before = buildSnapshot([userTable, sessionTable]);

  const userV2 = defineTable({
    tableName: 'user',
    columns: t => ({
      id: t.uuid().notNull().default(sql`gen_random_uuid()`),
      createdAt: t.timestamp({ withTimezone: true }).defaultNow().notNull(),
      nickname: t.varchar(), // notNull dropped
      avatarUrl: t.varchar(), // new column
      status: t.enum(['active', 'banned', 'deleted']).notNull(), // new enum value
      // email removed
    }),
    primaryKey: { columns: ['id'] },
    indexes: [{ unique: true, columns: ['nickname'], where: c => sql`${c.avatarUrl} is not null` }],
  });

  const after = buildSnapshot([userV2]); // session dropped

  test('changes come in a fixed order', () => {
    expect(diffSnapshots(before, after).map(c => c.kind)).toEqual([
      'dropIndex',
      'dropConstraint',
      'addColumn',
      'alterColumn',
      'replaceConstraint',
      'createIndex',
      'dropColumn',
      'dropTable',
    ]);
  });

  test('and render to the expected SQL', () => {
    expect(renderChanges(diffSnapshots(before, after))).toBe(`DROP INDEX "user_nickname_idx";
ALTER TABLE "user" DROP CONSTRAINT "user_nickname_check";
ALTER TABLE "user" ADD COLUMN "avatar_url" varchar;
ALTER TABLE "user" ALTER COLUMN "nickname" DROP NOT NULL;
ALTER TABLE "user" DROP CONSTRAINT "user_status_check", ADD CONSTRAINT "user_status_check" CHECK ("status" in ('active', 'banned', 'deleted'));
CREATE UNIQUE INDEX "user_nickname_idx" ON "user" ("nickname") WHERE "avatar_url" is not null;
ALTER TABLE "user" DROP COLUMN "email";
DROP TABLE "session";
`);
  });

  test('alterColumn prints one ALTER per difference', () => {
    const v1 = buildSnapshot([defineTable({ tableName: 't', columns: t => ({ a: t.integer() }) })]);
    const v2 = buildSnapshot([
      defineTable({ tableName: 't', columns: t => ({ a: t.bigint().notNull().default(0).generatedAlwaysAsIdentity() }) }),
    ]);
    expect(renderChanges(diffSnapshots(v1, v2))).toBe(`ALTER TABLE "t" ALTER COLUMN "a" TYPE bigint;
ALTER TABLE "t" ALTER COLUMN "a" SET DEFAULT 0;
ALTER TABLE "t" ALTER COLUMN "a" SET NOT NULL;
ALTER TABLE "t" ALTER COLUMN "a" ADD GENERATED ALWAYS AS IDENTITY;
`);
    expect(renderChanges(diffSnapshots(v2, v1))).toBe(`ALTER TABLE "t" ALTER COLUMN "a" TYPE integer;
ALTER TABLE "t" ALTER COLUMN "a" DROP DEFAULT;
ALTER TABLE "t" ALTER COLUMN "a" DROP NOT NULL;
ALTER TABLE "t" ALTER COLUMN "a" DROP IDENTITY;
`);
  });

  test('a new fk on an existing table goes last, after the indexes', () => {
    const parent = defineTable({ tableName: 'p', columns: t => ({ id: t.uuid().notNull() }), primaryKey: { columns: ['id'] } });
    const childV1 = defineTable({ tableName: 'c', columns: t => ({ pId: t.uuid() }) });
    const childV2 = defineTable({
      tableName: 'c',
      columns: t => ({ pId: t.uuid() }),
      indexes: [{ columns: ['pId'] }],
      foreignKeys: [{ columns: ['pId'], references: ref(parent, ['id']) }],
    });
    const kinds = diffSnapshots(buildSnapshot([parent, childV1]), buildSnapshot([parent, childV2])).map(c => c.kind);
    expect(kinds).toEqual(['createIndex', 'addConstraint']);
  });

  test('empty snapshot -> schema yields creation only', () => {
    expect(diffSnapshots(EMPTY_SNAPSHOT, before).map(c => c.kind)).toEqual([
      'createTable',
      'createTable',
      'createIndex',
      'addConstraint',
    ]);
  });
});
