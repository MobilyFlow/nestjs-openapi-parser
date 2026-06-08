import type { ClassDeclaration, MethodDeclaration, Type } from 'ts-morph';
import type {
  OpenApiInfo,
  OpenApiSchema,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiServer,
} from '../types/openapi';

/**
 * Context passed to the `buildResponseSchema` hook for a single controller method.
 * The hook decides what the final response body schema looks like — including any
 * project-specific envelope (e.g. `{ success, data }`) or pagination wrapping.
 */
export interface ResponseSchemaContext {
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

export interface NestParserHooks {
  /**
   * Decide the schema of the response body for an endpoint. If not provided, the
   * response body is the method's return type schema directly (no envelope).
   */
  buildResponseSchema?: (ctx: ResponseSchemaContext) => OpenApiSchema;

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
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
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

export interface NestParserConfig {
  openapi: OpenApiConfig;
  project?: ProjectConfig;
  conventions?: ConventionsConfig;
  hooks?: NestParserHooks;
  /**
   * Class references to force-include in `components.schemas`, even when no
   * endpoint reaches them. Pass the class itself (not its name) — we resolve
   * via `klass.name` against the project's AST index. Throws at build time if
   * any name cannot be matched, to surface typos and out-of-tree classes early.
   *
   * Transitive references of each entry are also pulled in (same reachability
   * walk as if an endpoint had returned the class).
   */
  additionalModels?: ModelConstructor[];
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
