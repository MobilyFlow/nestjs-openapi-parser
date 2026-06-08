# nestjs-openapi-parser

Generate an OpenAPI 3.x document from a NestJS project by **pure static analysis** of the TypeScript source. No app boot, no `reflect-metadata`, no runtime dependency on `@nestjs/*`. Just [ts-morph](https://ts-morph.com/) reading your `.ts` files.

Ships a CLI (`nestparser`) and a programmatic API.

## Why

`@nestjs/swagger` is excellent but requires booting the application and sprinkling `@Api*` decorators everywhere. `nestjs-openapi-parser` takes a different trade-off: it reads your existing code (controllers, DTOs, entities, JSDoc) and produces a spec without running anything. That makes it cheap to plug into CI, safe to run against half-broken branches, and ergonomic when your codebase already follows clear conventions (TypeORM entities, `class-validator` DTOs, JSDoc descriptions).

### Features

- **Zero runtime coupling** — no `@nestjs/*` deps, no `reflect-metadata`, the parser doesn't import your code.
- **JSDoc-driven descriptions** — class, method and property comments become OpenAPI `description` fields.
- **Reachability-only schemas** — only classes reached from an endpoint end up in `components.schemas`; orphans don't leak.
- **Nest mapped types** — `PartialType / PickType / OmitType / IntersectionType` are resolved structurally.
- **`@Query() dto: DTO`** is expanded into individual query parameters.
- **Documentation variants via `@Scope`** — emit `public`, `internal`, `admin`… flavors of the same spec from a single source.
- **Pluggable hooks** for response envelopes, security resolution, DTO/tag conventions.
- **Tiny config surface** with sane TypeORM + `class-validator` defaults.

## Requirements

- Node.js **>= 18**
- A NestJS (or NestJS-shaped) project with a `tsconfig.json`

You don't need to install `@nestjs/*` to run the parser — it only reads your source files.

## Install

One-off via `npx`:

```sh
npx nestjs-openapi-parser --project ./apps/api --out openapi.json
```

As a dev dependency:

```sh
npm install --save-dev nestjs-openapi-parser
# or
yarn add -D nestjs-openapi-parser
# or
pnpm add -D nestjs-openapi-parser
```

Then add a script:

```jsonc
// package.json
{
  "scripts": {
    "openapi": "nestparser --out docs/openapi.json"
  }
}
```

Or install globally:

```sh
npm install -g nestjs-openapi-parser
nestparser --help
```

## Quick start

1. Drop a config file at your project root:

```ts
// nestparser.config.ts
import { defineConfig } from 'nestjs-openapi-parser';

export default defineConfig({
  openapi: {
    title: 'My API',
    version: '1.0.0',
    servers: [{ url: 'http://localhost:3000' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  project: {
    globalPrefix: 'v1',
  },
});
```

2. Run the CLI:

```sh
npx nestparser --out openapi.json
```

That's it. You should see something like:

```
Project root: /path/to/your/api
Config file:  /path/to/your/api/nestparser.config.ts
Wrote /path/to/your/api/openapi.json (42 routes, 58 operations, 31 schemas).
```

## CLI usage

```
nestparser [options]

Options:
  -V, --version           output the version number
  -p, --project <path>    path to the NestJS project root (default: cwd)
  -o, --out <path>        path to the OpenAPI JSON output file (default: ./openapi.json)
  -c, --config <path>     path to the nestparser config file (default: auto-discover)
  -s, --scope <list>      active scopes (comma-separated; repeatable)
  -h, --help              display help
```

### Config file discovery

The CLI looks for the first file matching, inside `--project`:

```
nestparser.config.ts
nestparser.config.mts
nestparser.config.cts
nestparser.config.mjs
nestparser.config.cjs
nestparser.config.js
nestparser.config.json
```

`.ts` / `.mts` / `.cts` files are loaded via [`tsx`](https://github.com/privatenumber/tsx) (registered lazily — JSON-only users don't pay for it). Use `--config <path>` to point at an explicit file.

### Library use

```ts
import { parseNestProject, loadConfig } from 'nestjs-openapi-parser';
import { writeFileSync } from 'node:fs';

const projectRoot = process.cwd();
const { config } = await loadConfig({ projectRoot });
const document = parseNestProject({ projectRoot, config });

writeFileSync('openapi.json', JSON.stringify(document, null, 2));
```

You can also skip `loadConfig` entirely and pass the config object inline. Public exports live in [`src/lib.ts`](src/lib.ts): `parseNestProject`, `loadConfig`, `defineConfig`, the scope helpers (`getTags`, `getScopes`, `isVisible`, `filterScopedComments`, `parseScopeList`), and the relevant TypeScript types.

## What it parses

The parser walks `<projectRoot>/<rootDir>` (default `src/`), indexes every class and enum it sees, then emits paths and schemas from controllers and the types they reference.

**Deterministic output.** The source tree is walked in name-sorted order (not raw `fs.readdirSync` order, which is filesystem-dependent), so the order of paths, tags and schemas is identical on every machine — the generated JSON is safe to commit and diff in CI. Fields inside a model keep their **source-declaration order**, with inherited fields first (base class → subclass) when a class `extends` another.

### Routes

| Source                                                 | Becomes                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `@Controller('users')`                                 | base path + default tag derived from the class name (see below)                |
| `@Get/@Post/@Put/@Delete/@Patch('path')`               | OpenAPI operation under `paths[fullPath][httpMethod]`                          |
| `@Get(['a', 'b'])` / `@Controller(['x', 'y'])` arrays  | one operation per path (full prefix × route cross-product), unique operationIds |
| `:id` route placeholders                               | rewritten to `{id}` in the OpenAPI path                                        |
| `app.setGlobalPrefix('v1')`                            | declare via `project.globalPrefix` in the config                               |
| Method's JSDoc                                         | `operation.description`                                                        |
| Controller class JSDoc                                 | `tags[].description`                                                           |
| `@Tag <name>` JSDoc tag (controller or method)         | overrides the derived tag for that controller / operation                      |

**Default tag derivation.** The class name has its trailing `Controller` suffix stripped, then PascalCase boundaries are split with spaces — `UserAuthController` → `"User Auth"`, `HealthController` → `"Health"`, `APIClientController` → `"API Client"`. Override the rule globally via the [`controllerTag`](#hooks-project-specific-glue) hook, or per-controller / per-method via a `@Tag <name>` JSDoc tag (single line, like `@Scope`):

```ts
/**
 * @Tag System Health
 */
@Controller('health')
export class HealthController {
  @Get()
  /** @Tag Diagnostics */
  ping() { /* ... */ }
}
```

Every tag in play is also declared in the document's root `tags[]`. Controller tags come first (with the description from the class JSDoc, first controller winning on a shared name), followed by any method-level `@Tag` name no controller already declared. Those method-introduced tags carry no description — a method's JSDoc is its `operation.description`, not a tag description — but they're still declared so the operation's tag isn't dangling and tools order/group it like any other.

HTTP-method decorators (and `@Controller`, `@Body`, `@Query`, `@Param`, `@Headers`) are matched by **local identifier name**. Aliased imports like `import { Post as HttpPost }` won't be detected.

### Parameters & request body

| Source                                       | Becomes                                                      |
| -------------------------------------------- | ------------------------------------------------------------ |
| `@Param('id')`                               | path parameter (`required: true`)                            |
| `@Param('id', ParseUUIDPipe)`                | `{ type: 'string', format: 'uuid' }`                         |
| `@Param('id', ParseIntPipe)`                 | `{ type: 'integer' }`                                        |
| `@Param('id', ParseBoolPipe)`                | `{ type: 'boolean' }`                                        |
| `@Query('q')`                                | named query parameter                                        |
| `@Query() dto: SomeQueryDto`                 | expanded into individual query parameters from the DTO       |
| `@Body() dto: SomeBodyDto`                   | `requestBody` with `application/json` schema (`required: true`) |
| `@Headers('x-foo')`                          | header parameter (`type: string`)                            |

Pipe detection is **textual** — it looks for `ParseUUIDPipe` / `ParseIntPipe` / `ParseBoolPipe` in the decorator's arguments source. Custom pipes fall back to the parameter's TypeScript type.

**Path parameters always match the route template.** Every `:placeholder` in the route (`@Controller`, `@Get`, the global prefix) is emitted as a `required: true` path parameter, in template order — so the document is never invalid for a missing parameter object. When a `:placeholder` has a matching `@Param('placeholder')`, its schema (incl. pipe-derived `uuid`/`integer`/`boolean`) is used; otherwise — the handler reads `@Param() all`, `@Req()`, or the names simply don't line up — it defaults to `{ type: 'string' }`. A `@Param('x')` whose name isn't in the route template is ignored (it can't be a valid path parameter).

### Responses

The default is "method return type **is** the response body" with status `201` for `POST` and `200` for everything else. `Promise<T>` is unwrapped to `T` first. Customize the body with the [`buildResponseSchema`](#hooks-project-specific-glue) hook.

**`@HttpCode(...)` overrides the status.** A handler decorated with `@HttpCode(204)` (numeric literal) or `@HttpCode(HttpStatus.NO_CONTENT)` (the `HttpStatus` member is resolved from a built-in name→code table) uses that code as the response key instead of the 201/200 default — matching NestJS's own behavior.

### Schemas

The schema builder accepts TypeScript classes and produces OpenAPI object schemas:

| Source                                                | Becomes                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Class instance property                               | entry in `properties`                                                   |
| `prop?: T` **or** `@IsOptional() prop: T`             | excluded from `required` (decorator name configurable)                  |
| `@Exclude() prop: T`                                  | omitted from the schema entirely (decorator name configurable)          |
| `string` / `number` / `boolean` types                 | OpenAPI primitive                                                       |
| `Date`                                                | `{ type: 'string', format: 'date-time' }`                               |
| `T[]`                                                 | `{ type: 'array', items: schemaOf(T) }`                                 |
| TypeScript `enum`                                     | `{ type, enum: [...] }` — `type` is `string`, `integer`, or `number` by member value |
| `"a" \| "b" \| "c"` string-literal union              | `{ type: 'string', enum: ['a','b','c'] }`                               |
| Union of classes                                      | `{ oneOf: [...] }`                                                      |
| `extends PartialType(X)`                              | all properties of `X` made optional                                     |
| `extends PickType(X, ['a','b'])`                      | subset                                                                  |
| `extends OmitType(X, ['a','b'])`                      | complement                                                              |
| `extends IntersectionType(A, B, ...)`                 | merged                                                                  |
| Class JSDoc                                           | `schema.description`                                                    |
| Property JSDoc                                        | property-level `description`                                            |

#### Schema reachability

Only classes that are **reachable from an endpoint** end up in `components.schemas`:

- Controller method return types (after `Promise<T>` unwrap) and their nested class properties — transitively.
- `@Body()` parameter types and their nested classes.
- DTOs used as `@Query()` are **inlined** as individual query parameters, not emitted as named schemas.

Classes that never reach the reference walk (orphan entities, error envelopes only used in interceptors, discriminated-union variants…) won't appear in the spec by default. Add them explicitly via `additionalModels`:

```ts
import { CommonError } from './src/common/common-error';
import { AuditEvent } from './src/audit/audit-event';

export default defineConfig({
  // ...
  additionalModels: [CommonError, AuditEvent],
});
```

Pass the **class itself**, not its name — the parser resolves it via `klass.name` against the AST. Transitive references of each entry come along automatically. Build **throws** if a name isn't found in the source tree, so typos and out-of-tree classes fail loud.

## Configuration

A complete `nestparser.config.ts`:

```ts
import { defineConfig } from 'nestjs-openapi-parser';

export default defineConfig({
  openapi: {
    title: 'My API',
    version: '1.0.0',
    description: 'Optional API description.',
    servers: [{ url: 'http://localhost:3000' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    info: {
      // Anything extra spliced onto `info`.
      contact: { name: 'API team', email: 'api@example.com' },
    },
  },

  project: {
    tsConfigFilePath: 'tsconfig.json',
    rootDir: 'src',
    globalPrefix: 'v1',
    excludeSuffixes: ['.spec.ts', '.test.ts', '.d.ts'],
  },

  conventions: {
    entityDecorator: 'Entity',      // TypeORM @Entity
    excludeDecorator: 'Exclude',    // class-transformer @Exclude
    optionalDecorator: 'IsOptional', // class-validator @IsOptional
  },

  scopes: [],                        // see "Documentation variants"
  additionalModels: [],              // see "Schema reachability"

  hooks: {
    // see "Hooks"
  },
});
```

### Full reference

| Section       | Field               | Default                             | Purpose                                                              |
| ------------- | ------------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `openapi`     | `title`, `version`  | required                            | `info.title` / `info.version`                                        |
| `openapi`     | `description`       | _(none)_                            | `info.description`                                                   |
| `openapi`     | `servers`           | `[]`                                | OpenAPI `servers` block                                              |
| `openapi`     | `securitySchemes`   | `{}`                                | Named schemes referenced by `resolveSecurity` / the default policy   |
| `openapi`     | `info`              | `{}`                                | Extras merged onto `info` (contact, license, termsOfService, …)      |
| `project`     | `tsConfigFilePath`  | `tsconfig.json`                     | tsconfig used by ts-morph (relative to `--project` or absolute)      |
| `project`     | `rootDir`           | `src`                               | Source tree scanned for classes/enums/controllers                    |
| `project`     | `globalPrefix`      | `''`                                | Equivalent of `app.setGlobalPrefix(...)`                             |
| `project`     | `excludeSuffixes`   | `['.spec.ts', '.test.ts', '.d.ts']` | Filenames matching any suffix are skipped during scan                |
| `conventions` | `entityDecorator`   | `Entity` (TypeORM)                  | Decorator marking persisted entities                                 |
| `conventions` | `excludeDecorator`  | `Exclude`                           | Decorator hiding a property from schemas                             |
| `conventions` | `optionalDecorator` | `IsOptional`                        | Decorator marking a property as optional                             |
| (top-level)   | `additionalModels`  | `[]`                                | Force-include classes the reachability walk misses                   |
| (top-level)   | `scopes`            | `[]`                                | Active scopes for `@Scope` filtering                                 |
| (top-level)   | `hooks`             | `{}`                                | Project-specific extensibility — see [Hooks](#hooks-project-specific-glue) |

CLI flags override config when given: `--scope` replaces `scopes`; `--config` overrides discovery; `--project` and `--out` work as paths.

## Documentation variants — `@Scope`

Tag controllers, methods, models or fields with `@Scope` to make them appear in the spec only when the build is configured for a matching scope. Untagged items are always emitted.

```ts
/**
 * Admin-only operations.
 *
 * @Scope admin
 */
@Controller('admin')
export class AdminController {
  /* ... */
}

export class User {
  email!: string;

  /** @Scope internal */
  lastLoginIp?: string;

  /** @Scope admin */
  adminMeta?: AdminMeta;
}
```

**Syntax.** The tag must be on its own JSDoc line (after the `* ` prefix). Inline mentions like `Comment with @Scope foo` are treated as description text. Multiple values can be comma-separated (`@Scope internal,admin`) or on separate lines.

**Activate scopes.** Either via the CLI or the config:

```sh
nestparser --scope internal,admin            # comma-separated
nestparser --scope internal --scope admin    # repeatable
```

```ts
defineConfig({
  // ...
  scopes: ['internal', 'admin'],
});
```

The CLI flag overrides the config when present.

**Visibility matrix:**

| Item's `@Scope`   | Active scopes | Emitted?          |
| ----------------- | ------------- | ----------------- |
| _(none)_          | any           | ✅                |
| `internal`        | _(none)_      | ❌                |
| `internal`        | `internal`    | ✅                |
| `internal`        | `admin`       | ❌                |
| `internal, admin` | `admin`       | ✅ (intersection) |

**Soundness — no dangling refs.** If a visible item references a class whose scope wouldn't be emitted, the build fails fast with an error naming the offending class. Example: a `@Scope internal` method returns `Promise<AdminMeta>` where `AdminMeta` is `@Scope admin`; building with `--scope internal` alone throws. Building with `--scope internal,admin` succeeds.

### Scoped description fragments

Inside any JSDoc body (controller, method, model, field), you can mark text fragments that only appear under specific scopes:

```ts
/**
 * Generic description that always appears.
 *
 * <internal>
 * Extra context that only shows when scope=internal is active.
 * </internal>
 *
 * <admin>Inline fragments work too.</admin>
 */
```

- The item itself does **not** need a `@Scope` — fragments are independent of item visibility.
- Multiple fragments can appear in the same JSDoc; **nesting is not allowed**.
- Visibility follows the same rule as item-level `@Scope`: untagged text always appears; `<X>…</X>` appears only when `X` is in the active scopes; no active scope → all fragments are dropped.
- **Only known scope names are treated as fragments.** `X` is a fragment delimiter only when it's a scope declared somewhere in the project via `@Scope` (on any class, method, or property) or passed as an active scope. Any other angle-bracket text — generics in prose (`Array<string>`), placeholders (`<id>`, `<token>`), inline HTML (`<b>…</b>`) — is left **verbatim** and never triggers an error.
- Syntax errors (nesting, mismatched close, unclosed open) **throw** with the path of the offending item — but only for genuine scope fragments. A stray `<id>` in prose is not a scope, so it's ignored, not an error.

Known limitation: a fragment scope used **only** in `<X>…</X>` blocks — never as a `@Scope` tag and never activated — won't be in the project's scope vocabulary, so its text passes through as literal prose instead of being hidden. Declare the scope with a `@Scope` tag (or activate it) to make such fragments filterable.

## Hooks (project-specific glue)

Default behavior emits "vanilla NestJS" output: the method return type is the response body, every registered security scheme applies. Four hooks let you customize:

```ts
defineConfig({
  // ...
  hooks: {
    buildResponseSchema: (ctx) => { /* ... */ },
    resolveSecurity:    (ctx) => { /* ... */ },
    isDto:              (clazz) => { /* ... */ },
    controllerTag:      (clazz) => { /* ... */ },
  },
});
```

### `buildResponseSchema(ctx)`

Wrap responses in a project-specific envelope (e.g. `{ success, data }`) or special-case wrapper types (e.g. `PaginatedResponse<T>`).

```ts
buildResponseSchema: ({ returnType, returnTypeName, defaultSchema }) => {
  if (returnTypeName === 'PaginatedResponse') {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data:    { type: 'array', items: { type: 'object' } },
        pagination: { type: 'object', properties: { total: { type: 'integer' } } },
      },
      required: ['success', 'data', 'pagination'],
    };
  }
  return {
    type: 'object',
    properties: { success: { type: 'boolean' }, data: defaultSchema() },
    required: ['success', 'data'],
  };
}
```

`ctx.defaultSchema()` lazily computes the bare return-type schema — calling it registers a `$ref` if the return type is a class. Don't call it if you're replacing the body entirely (otherwise you'll pull schemas you don't reference).

### `resolveSecurity(ctx)`

Read your own auth decorator (e.g. `@Public()`, `@Auth(...)`) and produce security requirements.

```ts
resolveSecurity: ({ controller, method }) => {
  const isPublic = !!method.getDecorator('Public') || !!controller.getDecorator('Public');
  return isPublic ? [] : [{ bearerAuth: [] }];
}
```

Return:

- `[]` — endpoint is public (emits `security: []`)
- `[{ scheme: [] }, ...]` — explicit requirements
- `undefined` — fall back to the default (every registered scheme applies)

### `isDto(class)` and `controllerTag(class)`

Override the default conventions:

- `isDto` — default matches `*.dto.ts` filename **or** class name ending in `DTO`/`Dto`.
- `controllerTag` — default strips the `Controller` suffix and splits PascalCase boundaries with spaces (`UserAuthController` → `"User Auth"`). For one-off overrides, prefer the `@Tag <name>` JSDoc tag on the controller (or method) — no hook needed.

The test fixture's config at [`tests/fixtures/example-app/nestparser.config.ts`](tests/fixtures/example-app/nestparser.config.ts) demonstrates a working setup with both hooks (`{ success, message, data }` envelope, `PaginatedResponse<T>` special-casing, `@Public()`-based security).

## Programmatic API

```ts
import {
  parseNestProject,
  loadConfig,
  defineConfig,
  filterScopedComments,
  getScopes,
  getTags,
  isVisible,
  parseScopeList,
} from 'nestjs-openapi-parser';

import type {
  NestParserConfig,
  NestParserHooks,
  ResponseSchemaContext,
  SecurityContext,
  OpenApiDocument,
  OpenApiSchema,
} from 'nestjs-openapi-parser';

// Auto-discover + load nestparser.config.* from disk
const { config, filePath } = await loadConfig({ projectRoot });

// Or build the config inline
const inline = defineConfig({ openapi: { title: 'X', version: '1.0' } });

// Generate the document
const doc: OpenApiDocument = parseNestProject({ projectRoot, config });
```

The internal builders (`AstIndex`, `SchemaBuilder`, `PathBuilder`) are also exported if you need fine-grained control, but the stable surface is `parseNestProject` + `loadConfig`.

## Examples

A complete fixture lives under [`tests/fixtures/example-app/`](tests/fixtures/example-app/) — a self-contained NestJS app with controllers, DTOs, entities, mapped types, scopes and the envelope hook. The corresponding generated OpenAPI documents are snapshotted at [`tests/__snapshots__/`](tests/__snapshots__/) (one file per scope variant).

You can browse any snapshot in a [Scalar](https://github.com/scalar/scalar) UI:

```sh
yarn snapshot:serve                            # interactive picker (uses prompts)
yarn snapshot:serve openapi.admin.snap.json    # basename relative to tests/__snapshots__/
yarn snapshot:serve /tmp/some-spec.json        # any absolute path
SCALAR_PORT=9000 yarn snapshot:serve           # override the default port (8088)
```

## Development

Requirements: Node.js >= 18, Yarn 4 (Berry).

```sh
yarn install
yarn dev --help         # tsx, no compile
yarn build              # tsc → dist/
yarn lint
yarn format
yarn test               # vitest run
yarn test:watch         # vitest watch mode
yarn test -u            # refresh snapshots after intentional changes
```

The test suite snapshots one OpenAPI document per scope variant. After an intentional output change, run `yarn test -u` and commit the snapshot diff alongside the code change so reviewers see both.

## Limitations & roadmap

- Decorators are matched by **local identifier name**. Aliased imports (`import { Post as HttpPost }`) won't be detected — keep them un-aliased or extend via a hook.
- Pipe detection in `@Param` is textual (`ParseUUIDPipe` / `ParseIntPipe` / `ParseBoolPipe`). Custom pipes fall back to the parameter type.
- No support yet for `@nestjs/swagger`'s `@ApiProperty(...)` runtime overrides — describe properties via JSDoc instead.
- Module-level filtering (e.g. emit only routes from one Nest module) is not built in — control it at the `rootDir` / `excludeSuffixes` / `@Scope` level.

## License

MIT
