/**
 * Temporary databases for the integration tests. Every test gets its own database,
 * created through the admin connection from `DATABASE_URL`, and drops it afterwards.
 * This goes through `pg`, to look at the database independently of the driver under test.
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';

export const ADMIN_URL = process.env.DATABASE_URL;

export interface TempDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

export async function createTempDatabase(): Promise<TempDatabase> {
  if (ADMIN_URL === undefined) {
    throw new Error('DATABASE_URL is not set');
  }

  const name = `dk_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  await admin(`CREATE DATABASE "${name}"`);

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;

  return {
    url: url.toString(),
    drop: () => admin(`DROP DATABASE "${name}" WITH (FORCE)`),
  };
}

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();

  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** One query on a separate connection, to look at the database from the outside. */
export async function query<R extends Record<string, unknown>>(url: string, text: string, values?: unknown[]): Promise<R[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    return (await client.query(text, values)).rows as R[];
  } finally {
    await client.end();
  }
}

export async function tableNames(url: string): Promise<string[]> {
  const rows = await query<{ table_name: string }>(
    url,
    `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  );

  return rows.map(row => row.table_name);
}

export async function columnNames(url: string, table: string): Promise<string[]> {
  const rows = await query<{ column_name: string }>(
    url,
    `select column_name from information_schema.columns where table_name = $1 order by ordinal_position`,
    [table],
  );

  return rows.map(row => row.column_name);
}
