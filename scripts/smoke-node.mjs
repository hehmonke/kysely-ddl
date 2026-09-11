/**
 * Smoke test of the built package under Node with `pg`.
 * Run: `bun run build && DATABASE_URL=... node scripts/smoke-node.mjs`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { defineTable, generateMigration, sql, writeMigration } from '../dist/index.js';
import { createMigrator, migrateToLatest } from '../dist/migrator/index.js';

if (typeof globalThis.Bun !== 'undefined') {
  console.error('smoke-node: run this under Node, not Bun');
  process.exit(1);
}

const ADMIN_URL = process.env.DATABASE_URL;

if (ADMIN_URL === undefined) {
  console.error('smoke-node: DATABASE_URL is not set');
  process.exit(1);
}

async function admin(statement) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();

  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

const dbName = `dk_smoke_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
await admin(`create database "${dbName}"`);
const url = new URL(ADMIN_URL);
url.pathname = `/${dbName}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kysely-ddl-smoke-'));
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.toString() }) }) });

try {
  const userTable = defineTable({
    name: 'user',
    columns: t => ({ id: t.uuid().notNull().default(sql`gen_random_uuid()`), nickname: t.varchar().notNull() }),
    primaryKey: { columns: ['id'] },
  });
  const [init] = writeMigration(dir, 'init', generateMigration([userTable]));

  assert.deepEqual(await migrateToLatest({ db, migrationsDir: dir }), { applied: [init] });
  assert.deepEqual(await migrateToLatest({ db, migrationsDir: dir }), { applied: [] });
  assert.deepEqual(await createMigrator({ db, migrationsDir: dir }).status(), { applied: [init], pending: [] });

  await db.insertInto('user').values({ nickname: 'smoke' }).execute();
  assert.deepEqual(await db.selectFrom('user').select('nickname').execute(), [{ nickname: 'smoke' }]);

  console.log(`smoke-node: ok (${process.version}, migration ${init} applied via pg)`);
} finally {
  await db.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  await admin(`drop database "${dbName}" with (force)`);
}
