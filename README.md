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
```

## License

MIT
