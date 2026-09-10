/**
 * Values for jsonb columns.
 *
 * Drivers disagree on how a jsonb parameter should be passed. `pg` expects JSON
 * text: it serializes objects itself, but turns a JS array into a postgres array
 * literal (`{1,2,3}`) and gets `invalid input syntax for type json`. `Bun.SQL`
 * looks at the parameter type reported by the server and for jsonb serializes the
 * JS value to JSON itself, so a ready JSON string gets encoded a second time and
 * becomes a jsonb string, while a number or boolean is rejected by postgres.
 *
 * The one representation both understand is a text parameter with an explicit
 * `$1::text::jsonb` cast. That is what `jsonb()` and `jsonbArray()` build, and the
 * `Jsonb<T>` brand in the write types (`inferKyselyTable`) keeps a raw object or
 * string from being passed around the helper.
 *
 * ```ts
 * await db.insertInto('user').values({ settings: jsonb({ theme: 'dark' }) }).execute();
 * await db.updateTable('user').set({ settings: jsonb({ theme: 'light' }) }).execute();
 * await db.selectFrom('user').where('settings', '@>', jsonb({ theme: 'dark' })).execute();
 * ```
 */
import { type RawBuilder, sql } from 'kysely';

/** JSON text for a jsonb column. From the outside it is only produced by `jsonb()`. */
export type Jsonb<T> = string & { readonly __jsonb: T };

/**
 * A value for a jsonb column: an object, an array, a string, a number or a boolean.
 *
 * `null` and `undefined` are rejected on purpose. `jsonb(null)` would write JSON
 * null rather than SQL NULL: it passes a `NOT NULL` column, is invisible to
 * `IS NULL` and `COALESCE`, and is indistinguishable from SQL NULL when read.
 * SQL NULL for a nullable column is passed as a plain `null` without the helper.
 * A top-level JSON null is needed so rarely that raw `sql` remains for it.
 */
export function jsonb<T extends {}>(value: T): RawBuilder<Jsonb<T>> {
  return sql<Jsonb<T>>`${encode(value)}::text::jsonb`;
}

/** A value for a `jsonb[]` column: each element is a separate JSON value, `null` inside is JSON null. */
export function jsonbArray<T>(values: readonly T[]): RawBuilder<Jsonb<T>[]> {
  return sql<Jsonb<T>[]>`${pgArrayLiteral(values.map(encode))}::text::jsonb[]`;
}

function encode(value: unknown): string {
  // lib.d.ts types JSON.stringify as returning string, but for undefined, functions and symbols it returns undefined
  const text = JSON.stringify(value) as string | undefined;

  if (text === undefined) {
    throw new Error(`jsonb(): a value of type ${typeof value} cannot be serialized to JSON`);
  }

  return text;
}

/**
 * A postgres array literal from strings: `{"a","b,c","d\"e",NULL}`. Every element
 * is quoted, so commas, braces and spaces inside are safe.
 */
export function pgArrayLiteral(values: readonly (string | null)[]): string {
  const elements = values.map(value =>
    value === null ? 'NULL' : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
  );

  return `{${elements.join(',')}}`;
}
