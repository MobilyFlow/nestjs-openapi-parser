# nestjs-openapi-parser

Generate an OpenAPI 3.x document from a NestJS project by **pure static analysis** of the TypeScript source. No app boot, no `reflect-metadata`, no runtime dependency on `@nestjs/*`. Just [ts-morph](https://ts-morph.com/) reading your `.ts` files.

Ships a CLI (`nestparser`) and a programmatic API.

## Why

`@nestjs/swagger` is excellent but requires booting the application and sprinkling `@Api*` decorators everywhere.
`nestjs-openapi-parser` takes a different trade-off: it reads your existing code (controllers, DTOs, entities, JSDoc) and
produces a spec without running anything. That makes it cheap to plug into CI
and ergonomic when your codebase already follows clear conventions (TypeORM entities, `class-validator` DTOs, JSDoc descriptions).

### Features

- **Zero runtime coupling** — no `@nestjs/*` deps, no `reflect-metadata`, the parser doesn't import your code.
- **JSDoc-driven descriptions** — class, method and property comments become OpenAPI `description` fields.
- **Reachability-only schemas** — only classes reached from an endpoint end up in `components.schemas`; orphans don't leak.
- **Nest mapped types** — `PartialType / PickType / OmitType / IntersectionType` are resolved structurally.
- **`@Query() dto: DTO`** is expanded into individual query parameters.
- **`class-validator` constraints** — `@Min/@Max/@MinLength/@IsEmail/@IsUUID/@Matches/@IsInt`… become `minimum/maximum/minLength/format/pattern`…
- **Self-validating output** — every generated document is checked against the OpenAPI 3.x JSON Schema; an invalid spec throws instead of being emitted.
- **Pluggable hooks** for response envelopes, security resolution, and tag conventions.
- **Documentation variants via custom `@Scope` tag in JSDoc** — emit `public`, `internal`, `admin`… flavors of the same spec from a single source.
- **Tiny config surface** with sane defaults.

## Requirements

- Node.js **>= 18**
- A NestJS (or NestJS-shaped) project with a `tsconfig.json`

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
    title: 'My API', // Default to `package.json` name
    version: '1.0.0', // Default to `package.json` version
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

**Config is optional.** If auto-discovery finds nothing, the parser emits a warning and falls back to a default config — `openapi.title`/`version` come from the project's `package.json` (`name`/`version`), with everything else on engine defaults (`rootDir: src`, `tsConfigFilePath: tsconfig.json`, no hooks). This lets you run against a vanilla NestJS project with zero setup.

## Library usage

```ts
import { parseNestProject, loadConfig } from 'nestjs-openapi-parser';
import { writeFileSync } from 'node:fs';

const projectRoot = process.cwd();
const { config } = await loadConfig({ projectRoot });
const document = await parseNestProject({ projectRoot, config });

writeFileSync('openapi.json', JSON.stringify(document, null, 2));
```

See more in [Library Usage](docs/library-usage.md).

## How to use in NestJS

Write plain NestJS — the parser reads your controllers and models as-is. No config and no
extra decorators are required; JSDoc comments simply carry over as descriptions.

```ts
/** A registered user. */
export class User {
  id!: string; // → { type: 'string' }, required

  /** Display name. */
  name!: string; // property JSDoc → schema description

  email?: string; // optional (`?`) → omitted from `required`
}
```

```ts
import { Controller, Delete, Get, Param } from '@nestjs/common';
import { User } from './user.entity';

/** Manage users. */ // class JSDoc → `Users` tag description
@Controller('users')
export class UsersController {
  /** Fetch a single user by id. */ // method JSDoc → operation description
  @Get(':id') // `:id` → required path param; summary "Find One"
  findOne(@Param('id') id: string): Promise<User> {
    // return type `User` → 200 response body + `User` schema
  }

  /**
   * Permanently delete a user.
   *
   * @Scope admin   // emitted only when built with --scope admin
   * @Tag Admin     // groups this operation under the `Admin` tag
   * @Name Delete user // overrides the auto summary
   */
  @Delete(':id')
  remove(@Param('id') id: string): Promise<void> {}
}
```

Run `npx nestparser --out openapi.json` — that's it. See [What it parses](docs/parser.md) for
every supported construct (DTOs, `class-validator` constraints, enums, `@Scope`, `@Tag`, hooks…).

## Available JSDoc tags

Add these to a controller, method, or property JSDoc to enrich the output. Each must be on its own line (inline mentions are treated as description text).

| Tag                         | Applies to                      | Effect                                                                                          |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@Tag <name>`               | Controller or method            | Group the operation under `<name>` instead of the tag derived from the class name               |
| `@Name <text>`              | Method                          | Set the operation `summary` (otherwise the method name, humanized)                              |
| `@Scope <name>`             | Controller, method, or property | Emit the item only when `<name>` is an active scope. Comma-separated for several (`@Scope a,b`) |
| `@Accept <media-type>`      | Method                          | Request body (`@Body()`) media type — default `application/json`                                |
| `@ContentType <media-type>` | Method                          | Response media type — default `application/json`                                                |

Inside any JSDoc body you can also wrap text in `<scope>…</scope>` fragments to show it only under matching scopes — see [Configuration](docs/configuration.md#scoped-description-fragments).

## What it parses

See [Parser Documentation](docs/parser.md)

## Configuration

See [Configuration Documentation](docs/configuration.md)

## Examples

A complete fixture lives under [`tests/fixtures/example-app/`](tests/fixtures/example-app/) — a self-contained NestJS app with controllers, DTOs, entities, mapped types, scopes and the envelope hook. The corresponding generated OpenAPI documents are snapshotted at [`tests/__snapshots__/`](tests/__snapshots__/) (one file per scope variant).

You can browse any snapshot in a [Scalar](https://github.com/scalar/scalar) UI:

```sh
yarn snapshot:serve                            # interactive picker (uses prompts)
yarn snapshot:serve openapi.admin.snap.json    # basename relative to tests/__snapshots__/
yarn snapshot:serve /tmp/some-spec.json        # any absolute path
SCALAR_PORT=9000 yarn snapshot:serve           # override the default port (8088)
```

## Limitations

- Decorators are matched by **local identifier name**. Aliased imports (`import { Post as HttpPost }`) won't be detected — keep them un-aliased or extend via a hook.
- Pipe detection in `@Param` is textual (`ParseUUIDPipe` / `ParseIntPipe` / `ParseBoolPipe`). Custom pipes fall back to the parameter type.
- No support yet for `@nestjs/swagger`'s `@ApiProperty(...)` runtime overrides — describe properties via JSDoc instead.
- Module-level filtering (e.g. emit only routes from one Nest module) is not built in — control it at the `rootDir` / `excludeSuffixes` / `@Scope` level.
- Route patterns OpenAPI can't represent — inline regex (`:id(\d+)`), wildcards (`*`, `:splat*`), `+`/`*` modifiers, and more than one optional param in a route — are **skipped with a warning**. Optional params (`:id?`) are supported via path splitting.
