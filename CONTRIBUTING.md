# Contributing

Bug reports, questions and pull requests are welcome in the
[issue tracker](https://github.com/hehmonke/kysely-ddl/issues). For anything
bigger than a fix, open an issue first so that the approach can be agreed on
before the code is written. The scope is deliberately narrow: PostgreSQL only,
tables as code, plain `.sql` migrations, types for Kysely.

## Setup

[Bun](https://bun.sh) runs the tests, the linter and the build; Node is needed
only for the smoke test of the built package.

```bash
bun install
bun run db:up   # postgres:18-alpine in Docker on port 54329; `bun run db:down` removes it
export DATABASE_URL=postgres://postgres:postgres@localhost:54329/kysely_ddl
```

Any PostgreSQL you have admin access to works instead of the container: every
integration test creates its own temporary database through `DATABASE_URL` and
drops it afterwards. Without `DATABASE_URL` the integration tests are skipped and
only the unit tests run.

## Checks

```bash
bun test           # unit tests, plus the integration tests when DATABASE_URL is set
bun run typecheck  # tsc over src and test, including test/types.test-d.ts
bun run lint       # oxlint; `bun run lint:fix` sorts imports and exports for you
bun run build      # dist/ from src/: ESM plus .d.ts
bun run check      # all four in a row, what CI and prepublishOnly run
bun run smoke:node # the built dist under Node with pg; run `bun run build` first
```

Type-level checks live in `test/types.test-d.ts`. The file is never executed:
`tsc` reads it, and a wrong inferred type fails `bun run typecheck`.

The runner and provider tests run twice, through `PostgresDialect` over `pg` and
through the `Bun.SQL` dialect in `test/helpers/bun-dialect.ts`, so that driver
differences show up here rather than at a user's.

CI runs the four checks twice as well: on the Kysely from the lockfile and on
0.29.0, the oldest version `peerDependencies` allows, so that the floor stays a
tested promise. `test/package.test.ts` checks that the two places agree, so
raising the floor means changing both. To try the floor locally:

```bash
bun add -d kysely@0.29.0   # then the checks above; afterwards:
git checkout -- package.json bun.lock && bun install --frozen-lockfile
```

## Layout

```
src/
  index.ts            the `kysely-ddl` entry point
  table/              defineTable, the column builder base, sql`` expressions, identifier rules
  table/column-types/ one file per column type; a modifier for some types only lives on its builder there
  generator/          snapshot, diff, SQL rendering, generateMigration
  migrator/store.ts   migration files on disk, exported from the root entry point
  migrator/index.ts   the `kysely-ddl/migrator` entry point: runner.ts and provider.ts
  kysely/             InferKyselyTable / InferKyselyDatabase, jsonb() / jsonbArray()
test/
  *.test.ts           bun tests; the integration ones need DATABASE_URL
  types.test-d.ts     type-level checks, read by tsc only
  helpers/            temporary databases, a shared schema, the Bun.SQL dialect
```

Dependencies point one way: `table` ◄── `generator` ◄── `migrator/store` ◄── the
runner and the provider, while `kysely` depends on `table` alone. The root entry
point imports `kysely` (for `jsonb()` and to render `sql` fragments) and no
driver; `kysely-ddl/migrator` is separate so that a project which applies
migrations some other way does not pull the runner in.

A table feature, a new column type or a constraint option, is added the same way
every time: a field in `TableSpec` -> a field in the snapshot -> a branch in the
diff -> a branch in the renderer, with a test at each step. Snapshots written by
earlier versions must keep reading, so a new snapshot field needs a fallback when
it is absent, the way `concurrently` reads as `false` in older snapshots.

## Pull requests

- Keep a change focused; unrelated cleanups go in their own pull request.
- Add or adjust tests. A bug fix comes with a test that fails without it.
- Run `bun run check` before pushing. CI runs the same commands, plus the Node
  smoke test.
- Add an entry under `[Unreleased]` in `CHANGELOG.md`, in the
  [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, and mark
  breaking changes with **Breaking:**.

## Releasing

For maintainers. Versions follow [SemVer](https://semver.org/).

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a heading with the
   new version and the date, and set the same version in `package.json`.
2. Commit, tag the commit `vX.Y.Z` and push the tag. The tag must match
   `version` in `package.json`; the workflow checks that.
3. GitHub Actions (`.github/workflows/publish.yml`) runs typecheck, lint, tests
   and the build through `prepublishOnly`, then publishes to npm with provenance.

Authentication is npm trusted publishing (OIDC): npmjs.com trusts this repository
and the `publish.yml` workflow, so there is no token secret to rotate.
