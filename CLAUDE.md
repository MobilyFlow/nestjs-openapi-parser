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
    tags.ts             # JSDoc tag extraction + @Scope filtering + <scope>…</scope> fragments
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
    src/                   # 5 controllers (users, posts, auth, health, admin), entities,
                           # DTOs, enums, plus admin/admin-meta.ts for @Scope coverage
  parser.test.ts           # library API + targeted invariants + snapshot variants
  scope.test.ts            # @Scope filtering + <scope>…</scope> fragment unit + integration
  cli.test.ts              # spawns `tsx src/cli.ts` and asserts equality with the library output
  __snapshots__/
    openapi.snap.json      # the full document — committed, reviewable as a JSON diff
  .tmp/                    # CLI scratch output, gitignored
```

Rules to remember:

- The fixture is a **real installed package** via `workspaces: ["tests/fixtures/*"]` — not a stub. `yarn install` at the repo root provisions its deps.
- The fixture's tsconfig is **standalone** — it does not extend the package tsconfig.
- The snapshot file(s) live under `.prettierignore` because byte-equality with `JSON.stringify(doc, null, 2)` must be preserved. Don't reformat them manually.
- One snapshot is committed per scope variant (`openapi.snap.json`, `openapi.admin.snap.json`, `openapi.internal-admin.snap.json`). They're driven by `SNAPSHOT_VARIANTS` in `tests/parser.test.ts`; add another entry to add a flavor.
- `yarn snapshot:serve [file]` (the `scripts/serve-snapshot.ts` script) opens any of them under a Scalar UI. With no argument it lists the available snapshots interactively via `prompts`. An explicit argument can be a basename inside `tests/__snapshots__/` or any absolute path.
- The CLI test compares its subprocess output to the **library output at runtime**, not the snapshot, to avoid an ordering race when both files run in parallel under vitest.
- HTTP-method decorators are looked up by **identifier name** (`Post`, `Get`, ...). Aliased imports like `import { Post as HttpPost }` will not be detected — keep fixture entity names distinct from decorator names (`BlogPost`, not `Post`).
- After intentional output changes: `yarn test -u`, then commit the snapshot diff alongside the code change so reviewers see both.

## Conventions

- Engine modules stay generic. Anything MobilyFlow-specific lives in `examples/mobilyflow.config.ts`, not in `src/`.
- Hooks are the only extensibility point. New project-specific behavior → new hook on `NestParserConfig['hooks']`, default no-op.
- `defaultSchema` in hook contexts is a **getter** (`() => OpenApiSchema`) so optional schemas aren't registered as `$ref`s when the hook overrides them. Don't make it eager.
- Schema emission is **reachable-only** — only classes reached from endpoints (return types, `@Body()`, nested properties, transitive) end up in `components.schemas`. `seedAll()`-style preemptive seeding does NOT exist. Orphan classes are added via `config.additionalModels: [ClassRef, ...]` — passed as constructors, resolved by `klass.name` against the AST index, throws on miss.
- **JSDoc tags** are extracted via [src/parser/tags.ts](src/parser/tags.ts) (`getTags`, `getScopes`, `isVisible`, `parseScopeList`). ts-morph's native `JSDoc.getTags()` does the heavy lifting — tags must be at line-start to be recognized, matching the `* @TagName value` convention. Tag values are taken from **the same line only** (the first line of `getCommentText()`); subsequent lines remain part of the description even though ts-morph would otherwise attribute them to the tag's body.
- **Scope filtering** runs at four sites: (a) `PathBuilder.processController` skips invisible controllers entirely (their `tags[]` entry is therefore not emitted either); (b) the inner method loop skips invisible methods; (c) `SchemaBuilder.buildOwnMembers` skips invisible properties; (d) the `SchemaBuilder.build()` queue drain **throws** when a class popped from pending is invisible — this is the soundness check that guarantees no dangling refs. `additionalModels` adds a fifth, earlier check in [src/parser/index.ts](src/parser/index.ts) so misconfigured entries fail with a clearer message before the queue even starts.
- **Scoped description fragments** (`<scope>…</scope>` inside any JSDoc body) are filtered at the four description-extraction sites — `SchemaBuilder` (class + property) and `PathBuilder` (controller→tag + method→operation). The transformation is `filterScopedComments(rawDesc, activeScopes, { itemPath })` from [src/parser/tags.ts](src/parser/tags.ts) — a tokenizer that throws on nesting, mismatched closes, and unclosed opens. Whitespace is normalized: lines that contained only a tag are dropped, 3+ consecutive newlines collapse to 2, output is trimmed. Item visibility (`@Scope`) and description filtering are independent — an untagged item can carry `<internal>…</internal>` fragments and vice versa.
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
