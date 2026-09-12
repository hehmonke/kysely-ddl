import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';

/**
 * The peer dependency floor is a promise only while CI tests it: the `check` job
 * in `.github/workflows/ci.yml` runs on the oldest Kysely the range allows as well
 * as on the lockfile one, so the two places must move together.
 */
const read = (relative: string): string => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

describe('kysely peer dependency', () => {
  test('the floor in package.json is a version CI tests against', () => {
    const { peerDependencies } = JSON.parse(read('package.json')) as { peerDependencies: { kysely: string } };
    const match = /^>=(\d+\.\d+)$/.exec(peerDependencies.kysely);

    expect(match).not.toBeNull();

    const floor = `${match![1]}.0`;
    expect(read('.github/workflows/ci.yml')).toContain(`'${floor}'`);
  });
});
