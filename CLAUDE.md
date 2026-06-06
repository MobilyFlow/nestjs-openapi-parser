# Project: nestjs-openapi-parser

## Goal

Standalone CLI that consumes a NestJS project's TypeScript source and emits an OpenAPI 3.x document by **pure static analysis** with [ts-morph](https://ts-morph.com/). No `@nestjs/*` runtime deps. No `reflect-metadata`. No app boot.

Published as `nestjs-openapi-parser`. Invoked as `nestparser` (`bin` field).

## Tech stack

- **Package manager**: Yarn Berry v4, `nodeLinker: node-modules`.
- **Language**: TypeScript, `target: ES2022`, `module: commonjs`.
- **AST**: `ts-morph` — the only AST tool. Do not introduce `@nestjs/*` runtime deps or `reflect-metadata`.
- **CLI**: `commander`.
- **Config file loader**: handles `.ts/.mts/.cts/.mjs/.cjs/.js/.json` — `.ts*` files go through `tsx/cjs` (registered lazily).
- **Dev runner**: `tsx`.
- **Build**: `tsc` → `dist/`.
- **Lint**: ESLint 9 flat config + `typescript-eslint`.
- **Format**: Prettier.

## Layout

```
src/
  cli.ts                # CLI entrypoint — keeps the shebang. bin field points here.
  lib.ts                # Library entry — re-exports public API. main/types point here.
  config/
    types.ts            # NestParserConfig + hook contracts + defineConfig()
    defaults.ts         # Default project/conventions config
    loader.ts           # Cosmiconfig-style discovery + multi-format loading
    index.ts
  parser/
    index.ts            # parseNestProject(options) — orchestrates the three builders
    ast-index.ts        # Walk tsconfig project, index classes/enums/entities/DTOs/controllers
    schema-builder.ts   # TS classes → components.schemas
    path-builder.ts     # Controllers + HTTP decorators → paths, with hook injection
  types/
    openapi.ts          # OpenAPI document/schema types
examples/
  mobilyflow.config.ts  # Reference config reproducing the internal MobilyFlow POC
```

`src/cli.ts` MUST keep the `#!/usr/bin/env node` shebang — TypeScript preserves it through compilation, and `npx nestparser` depends on it.

## Common commands

```sh
yarn dev --project ./some/nest --out /tmp/openapi.json   # tsx, no compile
yarn build                                               # tsc → dist/
yarn start --help                                        # run compiled CLI
yarn lint
yarn format
```

To verify against the in-house POC at `../mobilyflow-backend/docs/scripts`:

```sh
node dist/cli.js \
  --project /Users/gtaja/Projects/MobilyFlow/mobilyflow-backend \
  --out /tmp/nestparser-out.json \
  --config ./examples/mobilyflow.config.ts
```

Then diff against `mobilyflow-backend/docs/openapi.json` (the POC's output). The
only legitimate diffs are: (a) our output adds method JSDoc descriptions the
POC didn't extract, and (b) our output correctly marks `@IsOptional() x?` props
as non-required (the POC overcounts these).

## Tests

```sh
yarn test           # vitest run
yarn test:watch     # vitest
yarn test -u        # update snapshot after intentional output changes
```

Layout:

```
tests/
  fixtures/example-app/    # self-contained NestJS app; installed as a Yarn workspace
    package.json           # depends on real @nestjs/common, class-validator, class-transformer
    tsconfig.json
    nestparser.config.ts   # exercises the envelope + @Public auth hooks
    src/                   # 4 controllers (users, posts, auth, health), 2 entities, DTOs, enums
  parser.test.ts           # library API + targeted invariants
  cli.test.ts              # spawns `tsx src/cli.ts` and asserts equality with the library output
  __snapshots__/
    openapi.snap.json      # the full document — committed, reviewable as a JSON diff
  .tmp/                    # CLI scratch output, gitignored
```

Rules to remember:

- The fixture is a **real installed package** via `workspaces: ["tests/fixtures/*"]` — not a stub. `yarn install` at the repo root provisions its deps.
- The fixture's tsconfig is **standalone** — it does not extend the package tsconfig.
- The snapshot file lives under `.prettierignore` because byte-equality with `JSON.stringify(doc, null, 2)` must be preserved. Don't reformat it manually.
- The CLI test compares its subprocess output to the **library output at runtime**, not the snapshot, to avoid an ordering race when both files run in parallel under vitest.
- HTTP-method decorators are looked up by **identifier name** (`Post`, `Get`, ...). Aliased imports like `import { Post as HttpPost }` will not be detected — keep fixture entity names distinct from decorator names (`BlogPost`, not `Post`).
- After intentional output changes: `yarn test -u`, then commit the snapshot diff alongside the code change so reviewers see both.

## Conventions

- Engine modules stay generic. Anything MobilyFlow-specific lives in `examples/mobilyflow.config.ts`, not in `src/`.
- Hooks are the only extensibility point. New project-specific behavior → new hook on `NestParserConfig['hooks']`, default no-op.
- `defaultSchema` in hook contexts is a **getter** (`() => OpenApiSchema`) so optional schemas aren't registered as `$ref`s when the hook overrides them. Don't make it eager.
- Schema emission is **reachable-only** — only classes reached from endpoints (return types, `@Body()`, nested properties, transitive) end up in `components.schemas`. `seedAll()`-style preemptive seeding does NOT exist. Orphan classes are added via `config.additionalModels: [ClassRef, ...]` — passed as constructors, resolved by `klass.name` against the AST index, throws on miss.
- One responsibility per file. CLI layer (`cli.ts`) only parses flags + writes the file; never put business logic there.
- Read `package.json` at runtime via `readFileSync` + `JSON.parse`, not via `import '../package.json'` — keeps `rootDir: src` clean.
- Public API is whatever `src/lib.ts` re-exports. If it's not in `lib.ts`, it's internal.
- Never commit `dist/` — gitignored, regenerated by `yarn build` / `prepublishOnly`.

## Out of scope (for now)

- Coverage reporting (`@vitest/coverage-v8`).
- Per-builder unit tests beyond the targeted invariants in `parser.test.ts`.
- `nestparser init` subcommand to scaffold a config.
- A `serve` subcommand (was decided against for v0).
- CI.
- Publishing — not published yet; do not run `yarn publish` until v0.1.0 is ready.
