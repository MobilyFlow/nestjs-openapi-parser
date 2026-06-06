# nestjs-openapi-parser

CLI that statically parses a NestJS project with [ts-morph](https://ts-morph.com/) and emits an OpenAPI 3.x document. No app boot, no `reflect-metadata`, no decorator-reflection at runtime — just AST.

## Install

```sh
npx nestparser --project ./apps/api --out openapi.json
```

Or install globally:

```sh
npm install -g nestjs-openapi-parser
nestparser --help
```

## Usage

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

The CLI looks for a config file in `--project` named (in order):
`nestparser.config.ts`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.js`, `.json`.

## Configuration

A minimal config:

```ts
// nestparser.config.ts
import { defineConfig } from 'nestjs-openapi-parser';

export default defineConfig({
  openapi: {
    title: 'My API',
    version: '1.0',
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

### Full surface

| Section       | Field               | Default                             | Purpose                                               |
| ------------- | ------------------- | ----------------------------------- | ----------------------------------------------------- |
| `openapi`     | `title`, `version`  | required                            | `info.title` / `info.version`                         |
| `openapi`     | `servers`           | `[]`                                | OpenAPI `servers` block                               |
| `openapi`     | `securitySchemes`   | `{}`                                | Defines named schemes referenced by `resolveSecurity` |
| `project`     | `tsConfigFilePath`  | `tsconfig.json`                     | tsconfig used by ts-morph                             |
| `project`     | `rootDir`           | `src`                               | Source tree scanned for classes/enums/controllers     |
| `project`     | `globalPrefix`      | `''`                                | Equivalent of `app.setGlobalPrefix(...)`              |
| `project`     | `excludeSuffixes`   | `['.spec.ts', '.test.ts', '.d.ts']` | Skipped during scan                                   |
| `conventions` | `entityDecorator`   | `Entity` (TypeORM)                  | Decorator marking persisted entities                  |
| `conventions` | `excludeDecorator`  | `Exclude`                           | Property hidden from schema                           |
| `conventions` | `optionalDecorator` | `IsOptional`                        | Property is optional                                  |
| (top-level)   | `additionalModels`  | `[]`                                | Force-include classes the reachability walk misses    |
| (top-level)   | `scopes`            | `[]`                                | Active scopes for `@Scope` filtering (see below)      |

### Schema reachability

Only classes that are **reachable from an endpoint** end up in `components.schemas`:

- Controller method return types (after `Promise<T>` unwrap) and their nested class properties — transitively.
- `@Body()` parameter types and their nested classes.
- DTOs used as `@Query()` are inlined as individual query parameters, not emitted as named schemas — pass them via `additionalModels` if you want both.

Classes that never reach the reference walk (orphan entities, error envelopes only used in interceptors, discriminated-union variants) won't appear in the spec by default. Add them explicitly:

```ts
import { CommonError } from './src/common/common-error';
import { AuditEvent } from './src/audit/audit-event';

export default defineConfig({
  // ...
  additionalModels: [CommonError, AuditEvent],
});
```

Pass the **class itself**, not its name — the parser resolves it via `klass.name` against the AST. Transitive references of each entry come along automatically. Build throws if a name isn't found in the source tree, so typos and out-of-tree classes fail loud.

### Scopes — generating documentation variants

Tag controllers, methods, models, or fields with `@Scope` to make them appear in the spec only when the build is configured for a matching scope. Untagged items are always emitted.

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

**Syntax.** The tag must be on its own JSDoc line (after the `* ` prefix). Inline mentions like `Comment with @Scope foo` are treated as description text. Multiple values can be comma-separated (`@Scope internal,admin`) or written on separate lines.

**Activate scopes.** Either via the CLI or the config:

```sh
nestparser --scope internal,admin                # comma-separated
nestparser --scope internal --scope admin        # repeatable
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

**Soundness — never dangling refs.** If a visible item references a class whose scope wouldn't be emitted, the build fails fast with a clear error naming the offending class. Example: a `@Scope internal` method returns `Promise<AdminMeta>` where `AdminMeta` is `@Scope admin`; building with `--scope internal` alone throws. Building with `--scope internal,admin` succeeds.

#### Scoped description fragments

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
- Syntax errors (nesting, mismatched close, unclosed open) **throw** with the path of the offending item.

Known limitation: fenced code blocks inside JSDoc are not protected. Avoid HTML-like `<X>…</X>` content inside ` ``` ` blocks if `X` could be confused for a scope name.

### Hooks (project-specific glue)

Default behavior emits "vanilla NestJS" output: the method return type is the response body, every registered security scheme applies. Three hooks let you customize:

- **`buildResponseSchema(ctx)`** — wrap responses in a project-specific envelope (e.g. `{ success, data }`) or special-case wrapper types (e.g. `PaginatedResponse<T>`). Use `ctx.defaultSchema()` to lazily get the bare return-type schema.
- **`resolveSecurity(ctx)`** — read your own auth decorator (e.g. `@AuthParams`) and produce the security entries. Return `[]` to mark public, `undefined` to keep the default.
- **`isDto(class)`** / **`controllerTag(class)`** — override conventions for DTO detection and tag derivation.

A reference config that reproduces the MobilyFlow internal POC (envelope + `PaginatedResponse` + `AuthParams`) lives at [`examples/mobilyflow.config.ts`](examples/mobilyflow.config.ts).

## Library use

```ts
import { parseNestProject, loadConfig } from 'nestjs-openapi-parser';

const { config } = await loadConfig({ projectRoot });
const document = parseNestProject({ projectRoot, config });
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

### Browsing snapshots

The test suite snapshots one OpenAPI document per scope variant (`openapi.snap.json`, `openapi.admin.snap.json`, `openapi.internal-admin.snap.json`). To view any of them in a Scalar UI:

```sh
yarn snapshot:serve                            # interactive picker (uses prompts)
yarn snapshot:serve openapi.admin.snap.json    # basename relative to tests/__snapshots__/
yarn snapshot:serve /tmp/some-spec.json        # any absolute path
SCALAR_PORT=9000 yarn snapshot:serve           # override the default port (8088)
```

## License

MIT
