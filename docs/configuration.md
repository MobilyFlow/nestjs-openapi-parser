# Configuration

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
    excludeDecorator: 'Exclude', // class-transformer @Exclude
    optionalDecorator: 'IsOptional', // class-validator @IsOptional
  },

  scopes: [], // see "Documentation variants" below
  additionalModels: [], // force-include unreachable models — see docs/parser.md
  pages: { files: ['./docs/getting-started.md'] }, // see "Markdown pages" below

  hooks: {
    // see "Hooks"
  },
});
```

## Markdown pages — `pages`

Render standalone Markdown files as documentation pages ahead of the API reference (via `x-tagGroups`, which Scalar and Redoc display in the sidebar, right under the Introduction):

```ts
defineConfig({
  // ...
  pages: {
    files: ['./docs/getting-started.md', './docs/authentication.md'],
    group: 'Documentation', // sidebar heading for the pages (default)
    apiGroup: 'API', // sidebar heading for the endpoints (default)
  },
});
```

- Each path is resolved relative to the project root (or absolute). A missing file fails the build.
- The page **title** is the file's first line when it's a `#` heading, otherwise the file name (without extension).
- Pages are emitted first, so they appear at the top of the sidebar.
- **Grouping is opt-in.** `group` / `apiGroup` switch on `x-tagGroups` navigation (a missing one falls back to its default). Omit **both** and no `x-tagGroups` is emitted — the pages simply lead the flat tag list (still first, just without section headers). When grouping is on, the API's own operation tags are gathered into the `apiGroup` section, because `x-tagGroups` hides any ungrouped tag.

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

**Activate scopes** via the CLI or the config:

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

- **Syntax.** The tag must be on its own JSDoc line. Inline mentions like `Comment with @Scope foo` are treated as description text. Multiple values can be comma-separated (`@Scope internal,admin`) or on separate lines.
- **Precedence.** The CLI `--scope` flag overrides `config.scopes` when present.
- **Soundness — no dangling refs.** If a visible item references a class whose scope wouldn't be emitted, the build fails fast with an error naming the offending class. Example: a `@Scope internal` method returns `Promise<AdminMeta>` where `AdminMeta` is `@Scope admin`; building with `--scope internal` alone throws. Building with `--scope internal,admin` succeeds.

## Scoped description fragments

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

Default behavior emits "vanilla NestJS" output: the method return type is the response body, every registered security scheme applies. Five hooks let you customize:

```ts
defineConfig({
  // ...
  hooks: {
    buildSuccessResponseSchema: (ctx) => {
      /* ... */
    },
    buildResponses: (ctx, responses) => {
      /* ... */
    },
    resolveSecurity: (ctx) => {
      /* ... */
    },
    controllerTag: (clazz) => {
      /* ... */
    },
    endpointSummary: (ctx) => {
      /* ... */
    },
  },
});
```

### `buildSuccessResponseSchema(ctx)`

Wrap the **success** response in a project-specific envelope (e.g. `{ success, data }`) or special-case wrapper types (e.g. `PaginatedResponse<T>`).

```ts
buildSuccessResponseSchema: ({ returnType, returnTypeName, defaultSchema }) => {
  if (returnTypeName === 'PaginatedResponse') {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'array', items: { type: 'object' } },
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
};
```

`ctx.defaultSchema()` lazily computes the bare return-type schema — calling it registers a `$ref` if the return type is a class. Don't call it if you're replacing the body entirely (otherwise you'll pull schemas you don't reference).

### `buildResponses(ctx, responses)`

Finalize the **full** responses map for an endpoint — typically to document errors (404, 422, 401, …). The hook receives the pre-populated map and returns the final one:

- the success entry (status from `@HttpCode`/the verb default, body from `buildSuccessResponseSchema`), plus
- one description-only entry per `@Response <code> <description>` JSDoc tag on the method (see below).

Its job is usually to attach `content` (the error body) for those codes, or add blanket errors. Mutating `responses` and returning it is fine; returning `undefined` keeps the pre-populated map.

```ts
buildResponses: ({ controller, method }, responses) => {
  const errorBody = {
    'application/json': { schema: { $ref: '#/components/schemas/ApiError' } },
  };
  // Fill a body for every error code the `@Response` tags declared.
  for (const [code, response] of Object.entries(responses)) {
    if (Number(code) >= 400 && !response.content) response.content = errorBody;
  }
  // Add a blanket 401 to secured endpoints.
  const isPublic = !!method.getDecorator('Public') || !!controller.getDecorator('Public');
  if (!isPublic) responses['401'] ??= { description: 'Unauthorized', content: errorBody };
  return responses;
};
```

`ctx` provides `{ controller, method, httpMethod, successStatus, typeToSchema }`. Reference a shared error schema with a literal `$ref` (register it via [`additionalModels`](#additionalmodels) so it lands in `components.schemas`), or build one from a `ts-morph` `Type` with `ctx.typeToSchema(...)`.

**Declaring error codes with `@Response`.** A method-level `@Response <code> <description>` JSDoc tag seeds a response entry (status + description only — no body). Repeat it per code:

```ts
/**
 * Fetch a single user by UUID.
 *
 * @Response 404 User not found
 * @Response 422 Validation failed
 */
@Get(':id')
findOne(@Param('id', ParseUUIDPipe) id: string): Promise<User> { /* ... */ }
```

This works standalone (the codes show up with just a description) or alongside `buildResponses` (which fills in the body). The description is optional — when omitted, the canonical HTTP reason phrase is used (`404` → `Not Found`). A tag naming the computed success code is ignored, since that entry is already seeded.

### `resolveSecurity(ctx)`

Read your own auth decorator (e.g. `@Public()`, `@Auth(...)`) and produce security requirements.

```ts
resolveSecurity: ({ controller, method }) => {
  const isPublic = !!method.getDecorator('Public') || !!controller.getDecorator('Public');
  return isPublic ? [] : [{ bearerAuth: [] }];
};
```

Return:

- `[]` — endpoint is public (emits `security: []`)
- `[{ scheme: [] }, ...]` — explicit requirements
- `undefined` — fall back to the default (every registered scheme applies)

### `controllerTag(class)`

Override the default tag derivation:

- `controllerTag` — default strips the `Controller` suffix and splits PascalCase boundaries with spaces (`UserAuthController` → `"User Auth"`). For one-off overrides, prefer the `@Tag <name>` JSDoc tag on the controller (or method) — no hook needed.

### `endpointSummary(ctx)`

Build the `operation.summary` for each endpoint. `ctx` provides `{ controller, method, httpMethod, defaultSummary }` (`defaultSummary` is the humanized method name). Return a string to use it, or `null`/`undefined` to keep `defaultSummary`. A method-level `@Name <text>` JSDoc tag overrides both the hook and the default.

```ts
endpointSummary: ({ httpMethod, defaultSummary }) =>
  `${httpMethod.toUpperCase()} — ${defaultSummary}`;
```

The test fixture's config at [`tests/fixtures/example-app/nestparser.config.ts`](../tests/fixtures/example-app/nestparser.config.ts) demonstrates a working setup (`{ success, message, data }` envelope, `PaginatedResponse<T>` special-casing, `@Public()`-based security).
