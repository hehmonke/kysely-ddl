import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A project that emits declarations (`declaration: true`, every composite
 * project) exports column helpers and tables whose types are inferred from the
 * builders. tsc can write such a type only if every alias in it is reachable
 * through the package's `exports`; one that lives in an unexported module is
 * "cannot be named without a reference to kysely-ddl/dist/..." (TS2742 in
 * TypeScript 5, TS2883 in 7).
 *
 * So the check runs against the package as published: `dist` built from `src`
 * into a consumer's `node_modules`, behind the real `exports` map.
 */
const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');

function runTsc(args: readonly string[], cwd: string): { code: number; output: string } {
  const result = Bun.spawnSync([process.execPath, tsc, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

  return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

const consumer = `
import { sql } from 'kysely';
import { columnBuilders as t, defineForeignKey, defineTable, ref } from 'kysely-ddl';

type UserId = string & { readonly __brand: 'user' };

export const userIdColumn = <N extends string>(name: N) => t.uuid(name).$type<UserId>();
export const counterColumn = <N extends string>(name: N) => t.int(name).generatedByDefaultAsIdentity();
export const createdAtColumn = <N extends string>(name: N) => t.timestamp(name, { withTimezone: true }).defaultNow();
export const statusColumn = <N extends string>(name: N) => t.enum(name, ['active', 'banned'] as const);
export const tagsColumn = <N extends string>(name: N) => t.varchar(name).array().default(sql\`'{}'\`);
export const profileColumn = <N extends string>(name: N) => t.jsonb(name).$type<{ theme: 'light' | 'dark' }>();

export const userTable = defineTable({
  name: 'user',
  columns: t => ({
    id: userIdColumn('id').notNull(),
    seq: counterColumn('seq'),
    createdAt: createdAtColumn('created_at').notNull(),
    status: statusColumn('status').notNull(),
    tags: tagsColumn('tags'),
    profile: profileColumn('profile'),
    rating: t.doublePrecision(),
    level: t.smallint().notNull(),
    bio: t.text(),
  }),
  primaryKey: { columns: ['id'] },
});

export const sessionTable = defineTable({
  name: 'session',
  columns: t => ({ id: t.uuid().notNull(), userId: userIdColumn('user_id').notNull() }),
  foreignKeys: [{ columns: ['userId'], references: ref(userTable, ['id']) }],
});

export const sessionUserFk = defineForeignKey(sessionTable, { name: 'session_user_fk', columns: ['userId'], references: ref(userTable, ['id']) });
`;

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kysely-ddl-consumer-'));

  const pkg = path.join(dir, 'node_modules', 'kysely-ddl');
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(pkg, 'package.json'));

  const build = runTsc(['-p', path.join(root, 'tsconfig.build.json'), '--outDir', path.join(pkg, 'dist')], root);

  if (build.code !== 0) {
    throw new Error(`building the package failed:\n${build.output}`);
  }

  fs.symlinkSync(path.dirname(require.resolve('kysely/package.json')), path.join(dir, 'node_modules', 'kysely'), 'junction');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'index.ts'), consumer);
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: 'out',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        target: 'es2023',
        skipLibCheck: true,
        types: [],
      },
      include: ['index.ts'],
    }),
  );
}, 120_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('declarations of a consumer', () => {
  test('inferred types of column helpers and tables can be named through the exports', () => {
    const { code, output } = runTsc(['-p', 'tsconfig.json'], dir);

    expect(output).toBe('');
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'out', 'index.d.ts'), 'utf8')).toContain('export declare const userTable');
  }, 60_000);
});
