import { describe, expect, test } from 'bun:test';

import { ColumnBuilder, IntegerColumnBuilder, columnBuilders as t, TimestampColumnBuilder } from '../src/index.ts';

describe('column builders: one builder per column type', () => {
  test('a modifier of a type is only there on that type', () => {
    expect('defaultNow' in t.timestamp()).toBe(true);
    expect('defaultNow' in t.uuid()).toBe(false);
    expect('generatedAlwaysAsIdentity' in t.integer()).toBe(true);
    expect('generatedAlwaysAsIdentity' in t.bigint()).toBe(true);
    expect('generatedAlwaysAsIdentity' in t.numeric()).toBe(false);
  });

  test('a chain keeps its builder; an array column is a plain column', () => {
    expect(t.timestamp().notNull()).toBeInstanceOf(TimestampColumnBuilder);
    expect(t.bigint().notNull().default(0)).toBeInstanceOf(IntegerColumnBuilder);
    expect(t.timestamp().array()).toBeInstanceOf(ColumnBuilder);
    expect(t.timestamp().array()).not.toBeInstanceOf(TimestampColumnBuilder);
  });

  test('the spec records the column kind', () => {
    expect(t.timestamp().spec.kind).toBe('timestamp');
    expect(t.enum(['a']).spec.kind).toBe('varchar');
  });

  test('a repeated modifier is not an error: the last call wins', () => {
    expect(t.varchar().default('a').default('b').spec.default).toBe('b');
    expect(t.varchar().notNull().notNull().spec.notNull).toBe(true);
  });
});
