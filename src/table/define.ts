/**
 * `defineTable`, a hybrid: columns as chains, everything else as a declarative block.
 *
 * The key difference from drizzle rc5: **the column name stays a literal in the type**.
 * When a name is not set explicitly, it is derived from the property name with the
 * same snake_case that is applied at runtime, at the type level too (see `SnakeCase`).
 * This is exactly what rc5 lacks, where `Column['_']['name']` collapses to `string`.
 *
 * Index and constraint names are optional as well, see `AUTO_NAMES`.
 */
import { type SnakeCase, toSnakeCase } from './casing.ts';
import { columnBuilders, type ColumnBuilders } from './column-types/index.ts';
import type { AnyColumn, ColumnCfg, ColumnSpec } from './columns.ts';
import { assertIdentifier, autoName } from './identifier.ts';
import { collectColumns, columnRef, inArray, isSql, renderSql, type Sql } from './sql.ts';

/**
 * Auto-name suffixes. The convention:
 *
 *   user_pk
 *   ticket_number_uq
 *   session_user_id_fk
 *   ticket_status_check
 *   user_resource_transaction_user_id_resource_idx
 *
 * The primary key is the only one named without columns: there is one per table.
 */
export const AUTO_NAMES = {
  primaryKey: 'pk',
  unique: 'uq',
  foreignKey: 'fk',
  check: 'check',
  index: 'idx',
} as const;

// ── table types ──────────────────────────────────────────────────────────────

/** Column config after its name has been resolved; `typed` is builder state and stays behind. */
export interface ResolvedColumnCfg extends Omit<ColumnCfg, 'name' | 'typed'> {
  readonly name: string;
}

type ResolveName<K extends string, C extends AnyColumn> = C['_']['name'] extends string
  ? C['_']['name']
  : SnakeCase<K>;

export type ResolveColumns<TCols extends Record<string, AnyColumn>> = {
  readonly [K in keyof TCols & string]: {
    readonly name: ResolveName<K, TCols[K]>;
    readonly kind: TCols[K]['_']['kind'];
    readonly data: TCols[K]['_']['data'];
    readonly notNull: TCols[K]['_']['notNull'];
    readonly hasDefault: TCols[K]['_']['hasDefault'];
    readonly array: TCols[K]['_']['array'];
    readonly identity: TCols[K]['_']['identity'];
    readonly enumValues: TCols[K]['_']['enumValues'];
    readonly json: TCols[K]['_']['json'];
    readonly bigint: TCols[K]['_']['bigint'];
  };
};

export type ReferentialAction = 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default';

/** A column with its name already resolved; this is what goes into the snapshot. */
export interface ResolvedColumn extends Omit<ColumnSpec, 'name'> {
  readonly name: string;
  /** The property name in the schema; needed for clear error messages. */
  readonly key: string;
}

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ResolvedColumn[];
  readonly primaryKey: { readonly name: string; readonly columns: readonly string[] } | undefined;
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: boolean;
    readonly columns: readonly string[];
    readonly where: Sql | undefined;
    /** Built and dropped with `CONCURRENTLY`, in a migration of its own. */
    readonly concurrently: boolean;
  }[];
  readonly foreignKeys: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly refTable: string;
    readonly refColumns: readonly string[];
    readonly onDelete: ReferentialAction | undefined;
    readonly onUpdate: ReferentialAction | undefined;
  }[];
  readonly checks: readonly { readonly name: string; readonly expression: Sql }[];
}

export interface Table<
  TName extends string = string,
  TColumns extends Record<string, ResolvedColumnCfg> = Record<string, ResolvedColumnCfg>,
> {
  readonly _: {
    readonly name: TName;
    readonly columns: TColumns;
  };
  readonly spec: TableSpec;
}

export type AnyTable = Table<string, Record<string, ResolvedColumnCfg>>;

/**
 * The mark `isTable` looks for. `Symbol.for`, not a fresh symbol: a schema
 * package of its own brings its own copy of kysely-ddl, and a table defined
 * there must still be recognized here.
 */
const TABLE_BRAND = Symbol.for('kysely-ddl.table');

/**
 * Is this a table? By the brand, not by the shape: `loadTables` walks whole
 * modules and must not mistake a config object for a table.
 */
export function isTable(value: unknown): value is AnyTable {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[TABLE_BRAND] === true;
}

/** Column references for the callbacks in checks and partial indexes. */
type Refs<TCols> = { readonly [K in keyof TCols]: Sql };

// ── options ──────────────────────────────────────────────────────────────────

export interface Reference {
  readonly table: AnyTable;
  readonly columns: readonly string[];
}

export interface ForeignKeyDef<TCols> {
  /** When not set, built as `{table}_{columns}_fk`. */
  readonly name?: string;
  readonly columns: readonly (keyof TCols & string)[];
  readonly references: Reference;
  readonly onDelete?: ReferentialAction;
  readonly onUpdate?: ReferentialAction;
}

/**
 * A reference to another table's columns.
 *
 * The target table comes first, so TypeScript infers it and checks the column
 * names. A field inside `foreignKeys` cannot do that: the array element type is
 * fixed, and there is nothing to infer from a neighbouring field.
 *
 * Checking element by element is still possible, via `const` inference of the
 * whole array intersected with a mapped type, but measurements put it at six
 * times the cost (175k instantiations vs 30k for 64 tables) for the same errors.
 */
export function ref<T extends AnyTable>(
  table: T,
  columns: readonly (keyof T['_']['columns'] & string)[],
): Reference {
  return { table, columns };
}

export interface TableOptions<
  TName extends string,
  TCols extends Record<string, AnyColumn>,
> {
  /** The table name in the database. Inferred as a literal; the Kysely interface keys come from it. */
  readonly name: TName;
  /**
   * Columns are declared with a callback that receives the builder set:
   *
   * ```ts
   * columns: t => ({ id: t.uuid().notNull(), status: t.enum(['new']) })
   * ```
   *
   * Builders are not exported one by one: there is exactly one form, and the
   * import list in the schema file does not need editing for every new column.
   *
   * Type inference is unaffected: TypeScript infers `TCols` from the callback's
   * return type BEFORE it starts checking the rest of the literal, so `indexes`,
   * `uniques`, `foreignKeys` and `checks` are typed as usual.
   */
  readonly columns: (t: ColumnBuilders) => TCols;
  readonly primaryKey?: {
    /** When not set, built as `{table}_pk`. */
    readonly name?: string;
    readonly columns: readonly (keyof TCols & string)[];
  };
  readonly uniques?: readonly {
    /** When not set, built as `{table}_{columns}_uq`. */
    readonly name?: string;
    readonly columns: readonly (keyof TCols & string)[];
  }[];
  readonly indexes?: readonly {
    /** When not set, built as `{table}_{columns}_idx`. */
    readonly name?: string;
    readonly unique?: boolean;
    readonly columns: readonly (keyof TCols & string)[];
    readonly where?: (c: Refs<TCols>) => Sql;
    /**
     * Build and drop the index with `CONCURRENTLY`, without locking the table
     * against writes. Postgres refuses that inside a transaction, so the
     * generator puts such statements into a separate migration marked
     * `--> no-transaction`, which the runner applies under `transaction: 'each'`.
     * Toggling the flag on an existing index changes nothing in the database.
     */
    readonly concurrently?: boolean;
  }[];
  readonly foreignKeys?: readonly ForeignKeyDef<TCols>[];
  readonly checks?: readonly {
    /** When not set, built as `{table}_{expression columns}_check`. */
    readonly name?: string;
    readonly expression: (c: Refs<TCols>) => Sql;
  }[];
}

/**
 * A fragment that cannot be rendered is a mistake in the schema. It is caught
 * here, where the schema is defined and the table and column are known, not
 * later in the generator.
 */
function assertRenders(expression: Sql, what: string): void {
  try {
    renderSql(expression);
  } catch (error) {
    throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

// ── defineTable ──────────────────────────────────────────────────────────────

export function defineTable<TName extends string, TCols extends Record<string, AnyColumn>>(
  options: TableOptions<TName, TCols>,
): Table<TName, ResolveColumns<TCols>> {
  const name = options.name;
  assertIdentifier(name, 'table');

  const columns: ResolvedColumn[] = [];
  const dbName: Record<string, string> = {};
  const refs: Record<string, Sql> = {};

  for (const [key, builder] of Object.entries(options.columns(columnBuilders))) {
    const resolved = builder.spec.name ?? toSnakeCase(key);
    assertIdentifier(resolved, `${name}.${key}`);

    if (builder.spec.enumValues !== undefined && builder.spec.array) {
      throw new Error(
        `${name}.${key}: enum().array() is not supported yet: a check for an array ` +
          'is written with `<@ ARRAY[...]`, add it by hand.',
      );
    }

    if (isSql(builder.spec.default)) {
      assertRenders(builder.spec.default, `${name}.${key}: default`);
    }

    columns.push({ ...builder.spec, name: resolved, key });
    dbName[key] = resolved;
    refs[key] = columnRef(resolved);
  }

  const seenColumns = new Set<string>();

  for (const column of columns) {
    if (seenColumns.has(column.name)) {
      throw new Error(`${name}: column name "${column.name}" is used twice`);
    }
    seenColumns.add(column.name);
  }

  const toDb = (keys: readonly string[]): string[] =>
    keys.map(key => {
      const resolved = dbName[key];

      if (resolved === undefined) {
        throw new Error(`${name}: no column ${key}`);
      }

      return resolved;
    });

  /** An explicit name is checked against the limit; a missing one is built and shortened. */
  const resolveName = (
    explicit: string | undefined,
    parts: readonly string[],
    suffix: string,
    what: string,
  ): string => {
    if (explicit !== undefined) {
      assertIdentifier(explicit, `${name}: ${what}`);

      return explicit;
    }

    return autoName([name, ...parts], suffix);
  };

  const typedRefs = refs as Refs<TCols>;

  // ── indexes ────────────────────────────────────────────────────────────────
  const indexes = (options.indexes ?? []).map(index => {
    const indexColumns = toDb(index.columns);
    const indexName = resolveName(index.name, indexColumns, AUTO_NAMES.index, 'index');
    const where = index.where !== undefined ? index.where(typedRefs) : undefined;

    if (where !== undefined) {
      assertRenders(where, `${name}: index ${indexName}`);
    }

    return {
      name: indexName,
      unique: index.unique ?? false,
      columns: indexColumns,
      where,
      concurrently: index.concurrently ?? false,
    };
  });

  // ── primary key ────────────────────────────────────────────────────────────
  const primaryKey = options.primaryKey !== undefined
    ? {
        // the only one named without columns: there is one per table
        name: resolveName(options.primaryKey.name, [], AUTO_NAMES.primaryKey, 'primary key'),
        columns: toDb(options.primaryKey.columns),
      }
    : undefined;

  // ── unique constraints ─────────────────────────────────────────────────────
  const uniques = (options.uniques ?? []).map(unique => {
    const uniqueColumns = toDb(unique.columns);

    return {
      name: resolveName(unique.name, uniqueColumns, AUTO_NAMES.unique, 'unique'),
      columns: uniqueColumns,
    };
  });

  // ── foreign keys ───────────────────────────────────────────────────────────
  const foreignKeys = (options.foreignKeys ?? []).map(foreignKey => {
    const fkColumns = toDb(foreignKey.columns);

    return {
      name: resolveName(foreignKey.name, fkColumns, AUTO_NAMES.foreignKey, 'foreign key'),
      columns: fkColumns,
      refTable: foreignKey.references.table.spec.name,
      refColumns: foreignKey.references.columns.map(key => {
        const target = foreignKey.references.table.spec.columns.find(c => c.key === key);

        if (target === undefined) {
          throw new Error(
            `${name}: table ${foreignKey.references.table.spec.name} has no column ${key}`,
          );
        }

        return target.name;
      }),
      onDelete: foreignKey.onDelete,
      onUpdate: foreignKey.onUpdate,
    };
  });

  // ── checks: automatic ones from enum() first, then the declared ones ───────
  const checks: { name: string; expression: Sql }[] = [];

  for (const column of columns) {
    if (column.enumValues === undefined) {
      continue;
    }
    checks.push({
      name: autoName([name, column.name], AUTO_NAMES.check),
      expression: inArray(columnRef(column.name), column.enumValues),
    });
  }

  for (const check of options.checks ?? []) {
    const expression = check.expression(typedRefs);
    const referenced = collectColumns(expression);

    if (check.name === undefined && referenced.length === 0) {
      throw new Error(
        `${name}: a check without a name must reference at least one column, ` +
          'otherwise there is nothing to build the name from. Set the name explicitly.',
      );
    }

    const checkName = resolveName(check.name, referenced, AUTO_NAMES.check, 'check');
    assertRenders(expression, `${name}: check ${checkName}`);
    checks.push({ name: checkName, expression });
  }

  // ── name uniqueness ────────────────────────────────────────────────────────
  // Constraint names are unique within a table, index names within the schema.
  // The overlap is checked only where it really conflicts: PRIMARY KEY and
  // UNIQUE create an index under their own name.
  const constraintNames = new Map<string, string>();

  const claim = (kind: string, constraintName: string) => {
    const owner = constraintNames.get(constraintName);

    if (owner !== undefined) {
      const who = owner === kind ? `twice as ${kind}` : `as ${owner} and as ${kind}`;
      throw new Error(
        `${name}: name "${constraintName}" is taken twice, ${who}. ` +
          'Auto-names are built from the table and columns, so two objects on the same ' +
          'columns collide: set an explicit name for at least one of them.',
      );
    }
    constraintNames.set(constraintName, kind);
  };

  if (primaryKey !== undefined) {
    claim('primary key', primaryKey.name);
  }

  for (const unique of uniques) {
    claim('unique', unique.name);
  }

  for (const foreignKey of foreignKeys) {
    claim('foreign key', foreignKey.name);
  }

  for (const check of checks) {
    claim('check', check.name);
  }

  const indexNames = new Set<string>();

  for (const index of indexes) {
    if (indexNames.has(index.name)) {
      throw new Error(
        `${name}: index name "${index.name}" is used twice. ` +
          'Two indexes on the same columns get the same auto-name: set an explicit name.',
      );
    }
    // PRIMARY KEY and UNIQUE create an index under their own name, so this would conflict
    const owner = constraintNames.get(index.name);

    if (owner === 'primary key' || owner === 'unique') {
      throw new Error(
        `${name}: index "${index.name}" has the same name as the ${owner}, ` +
          'which already creates an index with that name.',
      );
    }
    indexNames.add(index.name);
  }

  const spec: TableSpec = { name, columns, primaryKey, uniques, indexes, foreignKeys, checks };

  // the brand is not part of `Table`: it is how `isTable` recognizes the object,
  // not something to write by hand, so it stays out of the public type
  return { _: { name, columns: {} as ResolveColumns<TCols> }, spec, [TABLE_BRAND]: true } as Table<
    TName,
    ResolveColumns<TCols>
  >;
}
