# Parser

The parser walks `<projectRoot>/<rootDir>` (default `src/`), indexes every class and enum it sees, then emits paths and schemas from controllers and the types they reference.

**Deterministic output.** The source tree is walked in name-sorted order (not raw `fs.readdirSync` order, which is filesystem-dependent), so the order of paths, tags and schemas is identical on every machine — the generated JSON is safe to commit and diff in CI. Fields inside a model keep their **source-declaration order**, with inherited fields first (base class → subclass) when a class `extends` another.

## Routes

| Source                                                | Becomes                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@Controller('users')`                                | base path + default tag derived from the class name (see below)                                              |
| `@Get/@Post/@Put/@Delete/@Patch('path')`              | OpenAPI operation under `paths[fullPath][httpMethod]`                                                        |
| `@Get(['a', 'b'])` / `@Controller(['x', 'y'])` arrays | one operation per path (full prefix × route cross-product), unique operationIds                              |
| `:id` route placeholders                              | rewritten to `{id}` in the OpenAPI path                                                                      |
| `:id?` optional param                                 | split into two paths — without the segment and with `{id}` (params are always required)                      |
| `:id(\d+)` regex / `*` wildcard / `:x+` modifier      | **route skipped** with a warning — no faithful OpenAPI representation                                        |
| Method's JSDoc                                        | `operation.description`                                                                                      |
| Controller class JSDoc                                | `tags[].description`                                                                                         |
| Method name → `operation.summary`                     | humanized method name by default                                                                             |
| `@Tag <name>` JSDoc tag (controller or method)        | overrides the derived tag for that controller / operation                                                    |
| `@Scope <name>` JSDoc tag (controller or method)      | emitted only when that scope is active — see [Configuration](configuration.md#documentation-variants--scope) |
| `@Name <text>` JSDoc tag (method)                     | overrides the operation `summary`                                                                            |

```ts
/**
 * @Tag System Health
 */
@Controller('health')
export class HealthController {
  @Get()
  /** @Tag Diagnostics */
  ping() {
    /* ... */
  }
}
```

Every tag in play is also declared in the document's root `tags[]`. Controller tags come first (with the description from the class JSDoc, first controller winning on a shared name), followed by any method-level `@Tag` name no controller already declared. Those method-introduced tags carry no description — a method's JSDoc is its `operation.description`, not a tag description — but they're still declared so the operation's tag isn't dangling and tools order/group it like any other.

**Operation summary.** Every operation gets a `summary`. By default it's the **method name humanized** — camelCase/PascalCase split into words with the first letter capitalized (`findOne` → `"Find One"`, `remove` → `"Remove"`). Override it per-endpoint with a `@Name <text>` JSDoc tag on the method (single line, like `@Tag`), or globally with the [`endpointSummary`](configuration.md#hooks-project-specific-glue) hook. Precedence: **`@Name` > `endpointSummary` hook > default**; the hook returning `null`/`undefined` falls back to the default.

```ts
@Controller('posts')
export class PostsController {
  /** @Name Publish a post */
  @Post()
  create() {
    // summary: "Publish a post"
  }

  @Get(':id')
  findOne() {
    // summary: "Publish a post"
  }
}
```

HTTP-method decorators (and `@Controller`, `@Body`, `@Query`, `@Param`, `@Headers`) are matched by **local identifier name**. Aliased imports like `import { Post as HttpPost }` won't be detected.

## Parameters & request body

| Source                                       | Becomes                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `@Param('id')`                               | path parameter (`required: true`)                                         |
| `@Param('id', ParseUUIDPipe)`                | `{ type: 'string', format: 'uuid' }`                                      |
| `@Param('id', ParseIntPipe)`                 | `{ type: 'integer' }`                                                     |
| `@Param('id', ParseBoolPipe)`                | `{ type: 'boolean' }`                                                     |
| `@Query('q')`                                | named query parameter                                                     |
| `@Query() dto: SomeQueryDto`                 | expanded into individual query parameters from the DTO                    |
| `@Body() dto: SomeBodyDto`                   | `requestBody` with `application/json` schema (`required: true`)           |
| `@Headers('x-foo')`                          | header parameter (`type: string`)                                         |
| `@UploadedFile()` + `FileInterceptor('f')`   | `multipart/form-data` body with `f: { type: 'string', format: 'binary' }` |
| `@UploadedFiles()` + `FilesInterceptor('f')` | the same, as `{ type: 'array', items: { …binary } }`                      |

Pipe detection is **textual** — it looks for `ParseUUIDPipe` / `ParseIntPipe` / `ParseBoolPipe` in the decorator's arguments source. Custom pipes fall back to the parameter's TypeScript type.

**Path parameters always match the route template.** Every `:placeholder` in the route (`@Controller`, `@Get`, the global prefix) is emitted as a `required: true` path parameter, in template order — so the document is never invalid for a missing parameter object. When a `:placeholder` has a matching `@Param('placeholder')`, its schema (incl. pipe-derived `uuid`/`integer`/`boolean`) is used; otherwise — the handler reads `@Param() all`, `@Req()`, or the names simply don't line up — it defaults to `{ type: 'string' }`. A `@Param('x')` whose name isn't in the route template is ignored (it can't be a valid path parameter).

### File uploads

An endpoint with `@UploadedFile()` / `@UploadedFiles()` produces a `multipart/form-data` request body. The file field's **name** comes from the matching `FileInterceptor('field')` / `FilesInterceptor('field')` in `@UseInterceptors` (falling back to the parameter name if no interceptor is recognized), and its schema is `{ type: 'string', format: 'binary' }` — wrapped in an array for `@UploadedFiles` / `FilesInterceptor`. Any `@Body()` DTO on the same handler is **inlined** alongside the file field(s) in the one multipart object (just like `@Query() dto`). The media type defaults to `multipart/form-data` whenever a file is present; an explicit `@Accept` still overrides it.

```ts
@Post('upload')
@UseInterceptors(FileInterceptor('file'))
uploadFile(
  @Body() dto: UploadMonitoringDTO,            // form fields, inlined
  @UploadedFile() file: Express.Multer.File, // file: { type: string, format: binary }
) { /* ... */ }
```

The file is marked `required`. `FileFieldsInterceptor` (multiple named fields) isn't parsed yet — fall back to declaring the field via a JSDoc-described `@Body()` DTO if you need it.

## Responses

The default is "method return type **is** the response body" with status `201` for `POST` and `200` for everything else. `Promise<T>` is unwrapped to `T` first. Customize the success body with the [`buildSuccessResponseSchema`](configuration.md#hooks-project-specific-glue) hook.

**`@HttpCode(...)` overrides the status.** A handler decorated with `@HttpCode(204)` (numeric literal) or `@HttpCode(HttpStatus.NO_CONTENT)` (the `HttpStatus` member is resolved from a built-in name→code table) uses that code as the response key instead of the 201/200 default — matching NestJS's own behavior.

**Error responses.** Document additional codes with a method-level `@Response <code> <description>` JSDoc tag (repeatable) and/or the [`buildResponses`](configuration.md#hooks-project-specific-glue) hook, which receives the full responses map (success + tag-derived entries) and attaches the error bodies.

## Media types — `@Accept` / `@ContentType`

Request bodies and responses default to `application/json`. Override per endpoint with a JSDoc tag on the method (single line, like `@Tag`/`@Name`):

| Tag                         | Overrides                                   |
| --------------------------- | ------------------------------------------- |
| `@Accept <media-type>`      | the **request body** media type (`@Body()`) |
| `@ContentType <media-type>` | the **response** media type                 |

```ts
@Controller('files')
export class FilesController {
  /**
   * @Accept multipart/form-data
   * @ContentType application/xml
   */
  @Post('upload')
  upload(@Body() dto: UploadDto): FileInfo {
    /* ... */
  }
}
```

The `@Body()` schema becomes the `multipart/form-data` content, and the response schema the `application/xml` content. Each tag is independent — set one, the other stays JSON. `@Accept` has no effect on an endpoint without a `@Body()`; `@ContentType` has none when the response has no body.

## Schemas

The schema builder accepts TypeScript classes and produces OpenAPI object schemas:

| Source                                       | Becomes                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Class instance property                      | entry in `properties`                                                                |
| `prop?: T` **or** `@IsOptional() prop: T`    | excluded from `required` (decorator name configurable)                               |
| `@Exclude() prop: T`                         | omitted from the schema entirely (decorator name configurable)                       |
| `string` / `number` / `boolean` types        | OpenAPI primitive                                                                    |
| `Date`                                       | `{ type: 'string', format: 'date-time' }`                                            |
| `T[]`                                        | `{ type: 'array', items: schemaOf(T) }`                                              |
| TypeScript `enum`                            | `{ type, enum: [...] }` — `type` is `string`, `integer`, or `number` by member value |
| `"a" \| "b" \| "c"` string-literal union     | `{ type: 'string', enum: ['a','b','c'] }`                                            |
| Union of classes                             | `{ oneOf: [...] }`                                                                   |
| `extends PartialType(X)`                     | all properties of `X` made optional                                                  |
| `extends PickType(X, ['a','b'])`             | subset                                                                               |
| `extends OmitType(X, ['a','b'])`             | complement                                                                           |
| `extends IntersectionType(A, B, ...)`        | merged                                                                               |
| Class JSDoc                                  | `schema.description`                                                                 |
| Property JSDoc                               | property-level `description`                                                         |
| Property JSDoc on a **class-typed** property | `{ $ref, description }` (see below)                                                  |

Under OpenAPI 3.1 (JSON Schema 2020-12) a `$ref` may carry sibling keywords, and a sibling `description` overrides at the referencing site rather than merging with the target's own description. So a class-typed property that carries a JSDoc description is emitted as `{ $ref, description }` — the field description wins on that property, while the referenced model keeps its own description for the standalone schema view. Class-typed properties without a description stay a bare `{ $ref }`.

### `class-validator` constraints

Constraint decorators on a property are translated into the matching schema keywords (unknown decorators are ignored). These compose with the type-derived schema and propagate through `PartialType`/`PickType`/`OmitType`/`IntersectionType`:

| Decorator                               | Schema keyword(s)                      |
| --------------------------------------- | -------------------------------------- |
| `@Min(n)` / `@Max(n)`                   | `minimum` / `maximum`                  |
| `@MinLength(n)` / `@MaxLength(n)`       | `minLength` / `maxLength`              |
| `@Length(min, max)`                     | `minLength` + `maxLength`              |
| `@ArrayMinSize(n)` / `@ArrayMaxSize(n)` | `minItems` / `maxItems`                |
| `@IsEmail()`                            | `format: 'email'`                      |
| `@IsUrl()`                              | `format: 'uri'`                        |
| `@IsUUID()`                             | `format: 'uuid'`                       |
| `@IsDateString()`                       | `format: 'date-time'`                  |
| `@Matches(/re/)`                        | `pattern` (regex literal or string)    |
| `@IsInt()`                              | narrows `number` → `integer`           |
| `@IsPositive()` / `@IsNegative()`       | exclusive `minimum` / `maximum` of `0` |

So `@IsInt() @Min(1) @Max(100) limit: number` becomes `{ type: 'integer', minimum: 1, maximum: 100 }`, and `@IsEmail() email: string` becomes `{ type: 'string', format: 'email' }`. Like everything else, decorators are matched by **local identifier name**.

### Schema reachability

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
