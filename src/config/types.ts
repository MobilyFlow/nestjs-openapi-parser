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
   * Override the default DTO detection rule (`.dto.ts` filename or `DTO`/`Dto`
   * class-name suffix).
   */
  isDto?: (clazz: ClassDeclaration) => boolean;

  /**
   * Override the default tag derivation (strip `Controller` suffix from class name).
   */
  controllerTag?: (clazz: ClassDeclaration) => string;
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
  /** Decorator name marking a class as a persisted entity. Defaults to `Entity` (TypeORM). */
  entityDecorator?: string;
  /** Decorator name marking a property as excluded from serialization. Defaults to `Exclude`. */
  excludeDecorator?: string;
  /** Decorator name marking a property as optional. Defaults to `IsOptional`. */
  optionalDecorator?: string;
}

export interface NestParserConfig {
  openapi: OpenApiConfig;
  project?: ProjectConfig;
  conventions?: ConventionsConfig;
  hooks?: NestParserHooks;
}

/** Helper for `nestparser.config.ts` so users get full type-checking. */
export function defineConfig(config: NestParserConfig): NestParserConfig {
  return config;
}
