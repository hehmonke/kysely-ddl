/**
 * A minimal Kysely dialect over `Bun.SQL`, for tests only, to run the runner and
 * the provider through a second driver. Not part of the package: dialects are not
 * its concern. The compiler, adapter and introspector are Kysely's own postgres ones.
 *
 * JS arrays in parameters are encoded into postgres array literals here: `Bun.SQL`
 * 1.4 does not do it through `unsafe` (it joins with commas and no braces).
 *
 * `{ bigint: true }` is passed on to `Bun.SQL`: int8 comes back as `bigint` instead of a string.
 */
import { type ReservedSQL, SQL } from 'bun';

import {
  CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';

import { pgArrayLiteral } from '../../src/kysely/json.ts';

export interface BunSqlDialectOptions {
  /** `Bun.SQL`'s own option: int8 as `bigint` instead of a string. */
  readonly bigint?: boolean;
}

export class BunSqlDialect implements Dialect {
  readonly #url: string;
  readonly #options: BunSqlDialectOptions;

  constructor(url: string, options: BunSqlDialectOptions = {}) {
    this.#url = url;
    this.#options = options;
  }

  createDriver(): Driver {
    return new BunSqlDriver(this.#url, this.#options);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }
}

class BunSqlDriver implements Driver {
  readonly #url: string;
  readonly #options: BunSqlDialectOptions;
  #sql: SQL | undefined;

  constructor(url: string, options: BunSqlDialectOptions) {
    this.#url = url;
    this.#options = options;
  }

  async init(): Promise<void> {
    this.#sql = new SQL(this.#url, { bigint: this.#options.bigint ?? false });
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return new BunSqlConnection(await this.#sql!.reserve());
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const parts = ['start transaction'];

    if (settings.isolationLevel !== undefined) {
      parts.push(`isolation level ${settings.isolationLevel}`);
    }

    if (settings.accessMode !== undefined) {
      parts.push(settings.accessMode);
    }

    await connection.executeQuery(CompiledQuery.raw(parts.join(' ')));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    (connection as BunSqlConnection).release();
  }

  async destroy(): Promise<void> {
    await this.#sql?.close();
  }
}

const WRITE_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/** The way `pg` does it: array -> literal, objects inside -> JSON, null -> NULL. */
function encodeParameter(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return pgArrayLiteral(
    value.map(element => {
      if (element === null || element === undefined) {
        return null;
      }

      return typeof element === 'object' ? JSON.stringify(element) : String(element);
    }),
  );
}

class BunSqlConnection implements DatabaseConnection {
  readonly #reserved: ReservedSQL;

  constructor(reserved: ReservedSQL) {
    this.#reserved = reserved;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result: unknown[] & { command?: string; count?: number } = await this.#reserved.unsafe(
      compiledQuery.sql,
      compiledQuery.parameters.map(encodeParameter),
    );
    const affected =
      result.command !== undefined && WRITE_COMMANDS.has(result.command) && typeof result.count === 'number'
        ? BigInt(result.count)
        : undefined;

    return { rows: Array.from(result) as R[], numAffectedRows: affected };
  }

  // oxlint-disable-next-line require-yield -- streaming is not needed in tests
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('BunSqlDialect (test helper): stream() is not supported');
  }

  release(): void {
    this.#reserved.release();
  }
}
