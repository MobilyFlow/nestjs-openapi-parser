import type { ClassDeclaration, MethodDeclaration, Type } from 'ts-morph';
import type {
  OpenApiInfo,
  OpenApiResponse,
  OpenApiSchema,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiServer,
} from '../types/openapi';

/**
 * Context passed to the `buildSuccessResponseSchema` hook for a single controller
 * method. The hook decides what the success response body schema looks like —
 * including any project-specific envelope (e.g. `{ success, data }`) or
 * pagination wrapping.
 */
export interface SuccessResponseSchemaContext {
  method: MethodDeclaration;
  /** Method return type with `Promise<T>` already unwrapped to `T`. */
  returnType: Type;
  /** Symbol name of `returnType`, if any (e.g. `PaginatedResponse`, `User`, `Date`). */
  returnTypeName: string | undefined;
  /** Generic type arguments of `returnType` (e.g. `[User]` for `PaginatedResponse<User>`). */
  returnTypeArgs: Type[];
  /**
   * Lazily compute the schema for the bare return type (no envelope/wrapper).
   * Calling this registers a `$ref` to `components.schemas` if the return type
   * is a class — only call when you actually need it.
   */
  defaultSchema: () => OpenApiSchema;
  /** Convert any ts-morph `Type` to an OpenAPI schema fragment (registers refs). */
  typeToSchema: (type: Type) => OpenApiSchema;
}

/**
 * Context passed to the `resolveSecurity` hook for a single controller method.
 * Return `undefined` to keep the default (apply every registered security scheme),
 * `[]` to mark the endpoint public, or an explicit array of requirements.
 */
export interface SecurityContext {
  controller: ClassDeclaration;
  method: MethodDeclaration;
  /** Names of all security schemes declared under `openapi.securitySchemes`. */
  registeredSchemes: string[];
}

/**
 * Context passed to the `endpointSummary` hook for a single controller method.
 * Return a string to use as the operation `summary`, or `null`/`undefined` to
 * fall back to `defaultSummary`. A method-level `@Name` JSDoc tag overrides both.
 */
export interface EndpointSummaryContext {
  controller: ClassDeclaration;
  method: MethodDeclaration;
  /** Lowercase HTTP verb (`get`, `post`, `put`, `delete`, `patch`). */
  httpMethod: string;
  /** The default summary: the method name humanized (PascalCase split + capitalized). */
  defaultSummary: string;
}

/**
 * Context passed to the `buildResponses` hook for a single controller method.
 * The hook receives the pre-populated responses map (success entry plus any
 * `@Response` tag-derived, description-only error entries) and returns the final
 * map to emit — typically filling in `content` (error bodies) per status code.
 */
export interface ResponsesContext {
  controller: ClassDeclaration;
  method: MethodDeclaration;
  /** Lowercase HTTP verb (`get`, `post`, `put`, `delete`, `patch`). */
  httpMethod: string;
  /** The computed success status code (e.g. `'200'`, `'201'`, `'204'`). */
  successStatus: string;
  /** Convert any ts-morph `Type` to an OpenAPI schema fragment (registers refs). */
  typeToSchema: (type: Type) => OpenApiSchema;
}

export interface NestParserHooks {
  /**
   * Decide the schema of the success response body for an endpoint. If not
   * provided, the response body is the method's return type schema directly (no
   * envelope).
   */
  buildSuccessResponseSchema?: (ctx: SuccessResponseSchemaContext) => OpenApiSchema;

  /**
   * Finalize the full responses map for an endpoint. Receives the pre-populated
   * map — the success entry plus any `@Response <code> <description>` tag-derived
   * entries (description only, no `content`) — and returns the responses to
   * emit. This is where error bodies are attached (e.g. a `$ref` to a shared
   * error schema), or blanket errors added. Mutating `responses` and returning
   * it is fine. If not provided, the pre-populated map is used as-is.
   */
  buildResponses?: (
    ctx: ResponsesContext,
    responses: Record<string, OpenApiResponse>,
  ) => Record<string, OpenApiResponse>;

  /**
   * Decide which security requirements apply to an endpoint. Default behavior:
   * if any security schemes are registered, all of them apply (logical OR); else
   * no security entries are emitted.
   */
  resolveSecurity?: (ctx: SecurityContext) => OpenApiSecurityRequirement[] | undefined;

  /**
   * Override the default tag derivation (strip `Controller` suffix from class name).
   */
  controllerTag?: (clazz: ClassDeclaration) => string;

  /**
   * Build the `summary` for an endpoint. Return `null`/`undefined` to fall back
   * to the default (the method name humanized). A method-level `@Name` JSDoc tag
   * overrides both this hook and the default.
   */
  endpointSummary?: (ctx: EndpointSummaryContext) => string | null | undefined;
}

export interface OpenApiConfig {
  title: string;
  version: string;
  description?: string;
  servers?: OpenApiServer[];
  /**
   * Named security schemes. Entries whose value is `null`/`undefined` are
   * skipped — so a scheme can be included conditionally
   * (`bearerAuth: enabled ? {...} : undefined`) without it leaking into the
   * output or the default security policy.
   */
  securitySchemes?: Record<string, OpenApiSecurityScheme | null | undefined>;
  /** Document-level extras spliced onto `info`. */
  info?: Partial<OpenApiInfo>;
}

export interface ProjectConfig {
  /**
   * Path to the project's tsconfig (relative to the project root or absolute).
   * Defaults to `tsconfig.json`.
   */
  tsConfigFilePath?: string;
  /**
   * Directory containing the project's source files, relative to the project root.
   * Defaults to `src`.
   */
  rootDir?: string;
  /**
   * Global route prefix mirroring `app.setGlobalPrefix(...)`. Prepended to every
   * controller route. Defaults to empty (no prefix).
   */
  globalPrefix?: string;
  /**
   * Glob-ish suffixes to skip when scanning the source tree. Files matching any
   * of these are not indexed. Defaults to `['.spec.ts', '.test.ts', '.d.ts']`.
   */
  excludeSuffixes?: string[];
}

export interface ConventionsConfig {
  /** Decorator name marking a property as excluded from serialization. Defaults to `Exclude`. */
  excludeDecorator?: string;
  /** Decorator name marking a property as optional. Defaults to `IsOptional`. */
  optionalDecorator?: string;
}

/**
 * A class reference (concrete or abstract) — anything assignable to a class
 * constructor. Looked up against the project's AST index by `klass.name`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelConstructor = abstract new (...args: any[]) => unknown;

export interface PagesConfig {
  /**
   * Markdown files rendered as standalone pages. Each path is relative to the
   * project root or absolute. The page title is the file's first `# heading`
   * line (else the file name); that heading line is dropped from the content so
   * the title isn't rendered twice. The remaining body is `trimStart`ed.
   */
  files: string[];
  /**
   * Sidebar heading for the Markdown pages section. Setting this (or `apiGroup`)
   * switches on `x-tagGroups` grouped navigation; defaults to `Documentation`
   * for the missing one. When BOTH are omitted no `x-tagGroups` is emitted — the
   * pages simply lead the flat tag list (still rendered first, no group headers).
   */
  group?: string;
  /**
   * Sidebar heading that groups the API's operation tags — needed once grouping
   * is on, because `x-tagGroups` hides any ungrouped tag. Setting this (or
   * `group`) switches on grouping; defaults to `API` for the missing one.
   */
  apiGroup?: string;
}

export interface NestParserConfig {
  openapi: OpenApiConfig;
  project?: ProjectConfig;
  conventions?: ConventionsConfig;
  hooks?: NestParserHooks;
  /**
   * Standalone Markdown pages emitted ahead of the API reference via
   * `x-tagGroups` (rendered by Scalar/Redoc). Omit to emit no pages and no
   * `x-tagGroups` at all.
   */
  pages?: PagesConfig;
  /**
   * Models to force-include in `components.schemas`, even when no endpoint
   * reaches them. Two forms:
   *  - a class reference (the class itself, not its name) — resolved via
   *    `klass.name` against the project's AST index;
   *  - a string `'src/path/to/file.ts#ModelName'` (path relative to the project
   *    root, or a bare `'ModelName'`) — the only way to include an `interface`
   *    or `type` alias, since those have no runtime constructor to pass.
   *
   * Throws at build time if any entry cannot be matched, to surface typos and
   * out-of-tree models early. Transitive references of each entry are also
   * pulled in (same reachability walk as if an endpoint had returned it).
   */
  additionalModels?: (ModelConstructor | string)[];
  /**
   * Active scopes for this build. Items annotated with `@Scope` are emitted
   * only when their scope set intersects this list. Untagged items are always
   * emitted. Empty/undefined means "only untagged items".
   *
   * The CLI flag `--scope a,b` overrides this when given.
   */
  scopes?: string[];
}

/** Helper for `nestparser.config.ts` so users get full type-checking. */
export function defineConfig(config: NestParserConfig): NestParserConfig {
  return config;
}
