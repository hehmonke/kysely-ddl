import { describe, expect, test } from 'bun:test';

import { collectColumns, type ColumnRef, inArray, quoteIdentifier, quoteLiteral, renderSql, sql } from '../src/index.ts';

const col = (name: string): ColumnRef => ({ kind: 'column', name });

describe('sql``', () => {
  test('columns render with their database name, literals are escaped', () => {
    expect(renderSql(sql`${col('user_id')} = ${"o'neil"} and ${col('n')} > ${5}`)).toBe(`"user_id" = 'o''neil' and "n" > 5`);
  });

  test('boolean and null render as is', () => {
    expect(renderSql(sql`${true} or ${null}`)).toBe('true or NULL');
  });

  test('nested sql`` is an error', () => {
    const inner = sql`1`;
    expect(() => sql`${inner}`).toThrow(/nested sql``/);
  });

  test('an unsupported value is an error', () => {
    expect(() => sql`${new Date(0)}`).toThrow(/cannot interpolate/);
  });
});

describe('inArray / collectColumns', () => {
  test('inArray yields `col in (...)`', () => {
    expect(renderSql(inArray(col('status'), ['new', 'closed']))).toBe(`"status" in ('new', 'closed')`);
    expect(renderSql(inArray(col('n'), [1, 2]))).toBe(`"n" in (1, 2)`);
  });

  test('collectColumns: first-appearance order, no duplicates', () => {
    expect(collectColumns(sql`${col('b')} > ${col('a')} and ${col('b')} < 10`)).toEqual(['b', 'a']);
  });
});

describe('quote*', () => {
  test('identifiers double their quotes', () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  test('literals', () => {
    expect(quoteLiteral(null)).toBe('NULL');
    expect(quoteLiteral(1.5)).toBe('1.5');
    expect(quoteLiteral(false)).toBe('false');
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });
});
