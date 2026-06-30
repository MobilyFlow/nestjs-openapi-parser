# Project: nestjs-openapi-parser

## Goal

Standalone CLI that consumes a NestJS project's TypeScript source and emits an OpenAPI 3.x document by **pure static analysis** with [ts-morph](https://ts-morph.com/). No `@nestjs/*` runtime deps. No `reflect-metadata`. No app boot.

Published as `nestjs-openapi-parser`. Invoked as `nestparser` (`bin` field).

## Tech stack

- **Package manager**: Yarn Berry v4, `nodeLinker: node-modules`.
- **Language**: TypeScript, `target: ES2022`, `module: commonjs`.
- **AST**: `ts-morph` — the only AST tool. Do not introduce `@nestjs/*` runtime deps or `reflect-metadata`.
- **CLI**: `commander`.
- **Output validation**: `@seriousme/openapi-schema-validator` (ESM-only) checks the generated document against the OpenAPI 3.x JSON Schema. It's imported through a `Function('return import(...)')` shim in [src/validate.ts](src/validate.ts) so `tsc` doesn't downlevel the dynamic `import()` to a `require()` (which would throw on the ESM-only package under `module: commonjs`).
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
    index.ts            # parseNestProject(options) — async; orchestrates the three builders, then self-validates
    ast-index.ts        # Walk tsconfig project, index classes/interfaces/type-aliases/enums/controllers
    schema-builder.ts   # TS classes / interfaces / type aliases → components.schemas
    path-builder.ts     # Controllers + HTTP decorators → paths, with hook injection
    tags.ts             # JSDoc tag extraction + @Scope filtering + <scope>…</scope> fragments
  validate.ts           # validateDocument(doc) → { valid, errors } against the OpenAPI 3.x schema
  types/
    openapi.ts          # OpenAPI document/schema types
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

To smoke-test the CLI against a real NestJS codebase:

```sh
node dist/cli.js \
  --project /path/to/some/nest/project \
  --out /tmp/nestparser-out.json
```

Open the result in a Scalar UI via `yarn snapshot:serve /tmp/nestparser-out.json`.

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

- Engine modules stay generic. Project-specific behavior belongs in user configs (`nestparser.config.ts`) via the hook surface, not in `src/`. The test fixture at `tests/fixtures/example-app/nestparser.config.ts` is the in-tree reference.
- Hooks are the only extensibility point. New project-specific behavior → new hook on `NestParserConfig['hooks']`, default no-op. The five hooks today are `buildSuccessResponseSchema` (success-response envelope/wrapper), `buildResponses` (finalize the full responses map — receives success + `@Response`-tag-seeded entries, attaches error bodies, adds blanket errors), `resolveSecurity` (per-endpoint security from your own auth decorators), `controllerTag` (override the default tag derivation), and `endpointSummary` (override the humanized-method-name summary). Hook contracts live in [src/config/types.ts](src/config/types.ts).
- **Self-validation is a hard invariant.** `parseNestProject` is **async** and runs `validateDocument` on the finished document before returning; an invalid document **throws** (it signals a parser/config bug, never something to ship). Don't add a "skip validation" escape hatch — the throw is the contract. The CLI surfaces it as a non-zero exit, so it doubles as a CI gate.
- **`openapi.title`/`version` are filled, not required.** When a config omits either field (or there's no config at all), [src/config/loader.ts](src/config/loader.ts) backfills from the project's `package.json` (`name`/`version`, else generic `API`/`1.0.0`) and warns. A present field always wins; a missing one never blocks generation.
- `defaultSchema` in hook contexts is a **getter** (`() => OpenApiSchema`) so optional schemas aren't registered as `$ref`s when the hook overrides them. Don't make it eager.
- Schema emission is **reachable-only** — only models reached from endpoints (return types, `@Body()`, nested properties, transitive) end up in `components.schemas`. `seedAll()`-style preemptive seeding does NOT exist. A "model" is a `class`, `interface` or object `type` alias: classes keep a decorator-aware declaration walk (`buildMembers`, validator constraints, `@Exclude`/`@IsOptional`); interfaces and type aliases are read through the resolved `Type` (`membersFromType`), so `extends`, intersections and mapped members fold in for free. String-literal-union type aliases and `enum`s are emitted **inline** (not as named components), mirroring each other. `@Body()`/`@Query()` _parameter expansion_ stays class-only by design (NestJS DTOs are classes). Orphan models are added via `config.additionalModels` — either a `ClassRef` (resolved by `klass.name`) or a string `'src/path/file.ts#ModelName'` / bare `'ModelName'` (the only way to pin an interface/type, which has no constructor); throws on miss.
- **JSDoc tags** are extracted via [src/parser/tags.ts](src/parser/tags.ts) (`getTags`, `getScopes`, `isVisible`, `parseScopeList`). ts-morph's native `JSDoc.getTags()` does the heavy lifting — tags must be at line-start to be recognized, matching the `* @TagName value` convention. Tag values are taken from **the same line only** (the first line of `getCommentText()`); subsequent lines remain part of the description even though ts-morph would otherwise attribute them to the tag's body. Repeated tags accumulate into the per-name `string[]` — e.g. multiple `@Response <code> <description>` lines on a method each seed an error response entry (status + description; body filled by the `buildResponses` hook), parsed in [src/parser/path-builder.ts](src/parser/path-builder.ts).
- **Scope filtering** runs at four sites: (a) `PathBuilder.processController` skips invisible controllers entirely (their `tags[]` entry is therefore not emitted either); (b) the inner method loop skips invisible methods; (c) `SchemaBuilder.buildOwnMembers` (classes) and `membersFromType` (interfaces/type aliases) skip invisible properties; (d) the `SchemaBuilder.build()` queue drain **throws** when a model popped from pending is invisible — this is the soundness check that guarantees no dangling refs. `additionalModels` adds a fifth, earlier check in [src/parser/index.ts](src/parser/index.ts) so misconfigured entries fail with a clearer message before the queue even starts.
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
