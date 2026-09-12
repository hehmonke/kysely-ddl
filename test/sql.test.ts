import { describe, expect, test } from 'bun:test';

import { sql } from 'kysely';

import { collectColumns, inArray, quoteIdentifier, quoteLiteral, renderSql } from '../src/index.ts';

describe('sql``', () => {
  test('is not re-exported: the tag comes from kysely', async () => {
    expect(Object.keys(await import('../src/index.ts'))).not.toContain('sql');
  });

  test('sql.ref renders as a quoted identifier, literals are escaped and inlined', () => {
    expect(renderSql(sql`${sql.ref('user_id')} = ${"o'neil"} and ${sql.ref('n')} > ${5}`)).toBe(
      `"user_id" = 'o''neil' and "n" > 5`,
    );
  });

  test('boolean and null render as is', () => {
    expect(renderSql(sql`${true} or ${null}`)).toBe('true or NULL');
  });

  test('a fragment nests into another', () => {
    const notEmpty = sql`char_length(${sql.ref('nickname')}) >= ${2}`;
    expect(renderSql(sql`${notEmpty} and ${sql.ref('email')} is not null`)).toBe(
      `char_length("nickname") >= 2 and "email" is not null`,
    );
  });

  test('sql.join, sql.lit and sql.raw pass through', () => {
    expect(renderSql(sql`${sql.join([1, sql.lit('x'), sql.raw('now()')])}`)).toBe(`1, 'x', now()`);
  });

  test('a table-qualified reference', () => {
    expect(renderSql(sql`${sql.ref('t.col')}`)).toBe('"t"."col"');
  });

  test('an unsupported value is an error', () => {
    expect(() => renderSql(sql`${new Date(0)}`)).toThrow(/cannot interpolate/);
    expect(() => renderSql(sql`${{ a: 1 }}`)).toThrow(/cannot interpolate into sql``: \{"a":1\}/);
    expect(() => renderSql(sql`${undefined}`)).toThrow(/cannot interpolate/);
  });

  test('an array is an error that points at the list helpers', () => {
    expect(() => renderSql(sql`${sql.ref('s')} in ${['a', 'b']}`)).toThrow(/\["a","b"\].*inArray\(\).*sql\.join\(\)/);
  });
});

describe('inArray / collectColumns', () => {
  test('inArray yields `col in (...)`', () => {
    expect(renderSql(inArray(sql.ref('status'), ['new', 'closed']))).toBe(`"status" in ('new', 'closed')`);
    expect(renderSql(inArray(sql.ref('n'), [1, 2]))).toBe(`"n" in (1, 2)`);
  });

  test('collectColumns: first-appearance order, no duplicates', () => {
    expect(collectColumns(sql`${sql.ref('b')} > ${sql.ref('a')} and ${sql.ref('b')} < 10`)).toEqual(['b', 'a']);
  });

  test('collectColumns looks into nested fragments and qualified references', () => {
    const inner = sql`${sql.ref('z')} > 0`;
    expect(collectColumns(sql`${inner} and ${sql.ref('t.q')} and ${inArray(sql.ref('s'), ['a'])}`)).toEqual(['z', 'q', 's']);
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
