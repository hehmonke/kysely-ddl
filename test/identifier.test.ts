import { describe, expect, test } from 'bun:test';

import { assertIdentifier, autoName, fitIdentifier, MAX_IDENTIFIER_BYTES } from '../src/index.ts';

describe('fitIdentifier', () => {
  test('leaves a short name alone', () => {
    expect(fitIdentifier('user_pk')).toBe('user_pk');
  });

  test('shortens a long name to the limit, the suffix is a hash of the full name', () => {
    const fitted = fitIdentifier(`${'a'.repeat(70)}_idx`);
    expect(Buffer.byteLength(fitted)).toBe(MAX_IDENTIFIER_BYTES);
    expect(fitted).toMatch(/^a+_[0-9a-f]{8}$/);
  });

  test('is deterministic and tells names with a common prefix apart', () => {
    const a = fitIdentifier(`${'x'.repeat(80)}_a`);
    const b = fitIdentifier(`${'x'.repeat(80)}_b`);
    expect(a).toBe(fitIdentifier(`${'x'.repeat(80)}_a`));
    expect(a).not.toBe(b);
  });

  test('counts bytes, not characters', () => {
    expect(Buffer.byteLength(fitIdentifier('ü'.repeat(40)))).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES); // 80 bytes
  });
});

describe('assertIdentifier', () => {
  test('an empty name is an error', () => {
    expect(() => assertIdentifier('', 'table')).toThrow(/empty name/);
  });

  test('over the limit is an error naming the length', () => {
    expect(() => assertIdentifier('a'.repeat(64), 'index')).toThrow(/is 64 bytes long/);
  });

  test('within the limit passes', () => {
    expect(() => assertIdentifier('a'.repeat(63), 'index')).not.toThrow();
  });
});

describe('autoName', () => {
  test('joins the parts with underscores and appends the suffix', () => {
    expect(autoName(['ticket', 'user_id', 'status'], 'idx')).toBe('ticket_user_id_status_idx');
  });
});
