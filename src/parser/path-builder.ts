import {
  ClassDeclaration,
  Decorator,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Type,
} from 'ts-morph';
import type { NestParserHooks } from '../config/types';
import type { OpenApiResponse, OpenApiSchema, OpenApiSecurityRequirement } from '../types/openapi';
import { AstIndex } from './ast-index';
import { SchemaBuilder } from './schema-builder';
import { filterScopedComments, getScopes, getTags, isVisible } from './tags';

const HTTP_METHODS: Record<string, string> = {
  Get: 'get',
  Post: 'post',
  Put: 'put',
  Delete: 'delete',
  Patch: 'patch',
};

// Media type used for request bodies and responses unless an endpoint overrides
// it with `@Accept` (request) or `@ContentType` (response) in its JSDoc.
const DEFAULT_MEDIA_TYPE = 'application/json';

// Default request media type for endpoints with a file upload (binary data
// can't ride in JSON), used unless `@Accept` says otherwise.
const MULTIPART_MEDIA_TYPE = 'multipart/form-data';

// NestJS's `HttpStatus` enum (from `@nestjs/common`) member name → numeric code.
// Used to resolve `@HttpCode(HttpStatus.NO_CONTENT)` statically, since we can't
// import `@nestjs/common` to read the value at runtime.
const HTTP_STATUS_CODES: Record<string, number> = {
  CONTINUE: 100,
  SWITCHING_PROTOCOLS: 101,
  PROCESSING: 102,
  EARLYHINTS: 103,
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NON_AUTHORITATIVE_INFORMATION: 203,
  NO_CONTENT: 204,
  RESET_CONTENT: 205,
  PARTIAL_CONTENT: 206,
  AMBIGUOUS: 300,
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  SEE_OTHER: 303,
  NOT_MODIFIED: 304,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  NOT_ACCEPTABLE: 406,
  PROXY_AUTHENTICATION_REQUIRED: 407,
  REQUEST_TIMEOUT: 408,
  CONFLICT: 409,
  GONE: 410,
  LENGTH_REQUIRED: 411,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  URI_TOO_LONG: 414,
  UNSUPPORTED_MEDIA_TYPE: 415,
  REQUESTED_RANGE_NOT_SATISFIABLE: 416,
  EXPECTATION_FAILED: 417,
  I_AM_A_TEAPOT: 418,
  MISDIRECTED: 421,
  UNPROCESSABLE_ENTITY: 422,
  FAILED_DEPENDENCY: 424,
  PRECONDITION_REQUIRED: 428,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
  HTTP_VERSION_NOT_SUPPORTED: 505,
};

/** Humanize a method name: split camelCase/PascalCase boundaries and capitalize. */
function humanizeMethodName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface PathBuilderOptions {
  globalPrefix?: string;
  hooks?: NestParserHooks;
  registeredSchemes?: string[];
  activeScopes?: Set<string>;
  /** Scope vocabulary used to recognize `<scope>…</scope>` description fragments. */
  knownScopes?: Set<string>;
}

/**
 * Converts NestJS controllers into the OpenAPI `paths` object by static analysis:
 * `@Controller` + HTTP route decorators, `@Param/@Query/@Body/@Headers`, method
 * return types, and pluggable hooks for response envelope and security.
 */
export class PathBuilder {
  private readonly paths: Record<string, Record<string, unknown>> = {};
  private readonly usedOperationIds = new Set<string>();
  private readonly tags = new Map<string, string | undefined>();
  /**
   * Tag names actually referenced by an emitted operation — each operation's
   * `@Tag`, or the controller tag it falls back to. A controller tag absent here
   * is unused (e.g. its only method overrides it with its own `@Tag`) and so is
   * not emitted in the root `tags[]`.
   */
  private readonly usedTagNames = new Set<string>();
  private readonly globalPrefix: string;
  private readonly hooks: NestParserHooks;
  private readonly registeredSchemes: string[];
  private readonly activeScopes: Set<string>;
  private readonly knownScopes: Set<string> | undefined;

  constructor(
    private readonly index: AstIndex,
    private readonly schemaBuilder: SchemaBuilder,
    options: PathBuilderOptions = {},
  ) {
    this.globalPrefix = options.globalPrefix ?? '';
    this.hooks = options.hooks ?? {};
    this.registeredSchemes = options.registeredSchemes ?? [];
    this.activeScopes = options.activeScopes ?? new Set();
    this.knownScopes = options.knownScopes;
  }

  build(): Record<string, Record<string, unknown>> {
    for (const controller of this.index.getControllers()) {
      this.processController(controller);
    }
    // Declare any method-level @Tag name no controller already declared, so the
    // operation's tag isn't dangling. Done after all controllers so a controller's
    // description always wins over a description-less method-tag placeholder.
    for (const name of this.usedTagNames) {
      if (!this.tags.has(name)) this.tags.set(name, undefined);
    }
    return this.paths;
  }

  /**
   * Root `tags[]` entries: one per tag name actually used by an operation.
   * Controller tags (name from `@Tag`/the default-tag hook, description from the
   * class JSDoc; first controller wins on a shared name) come first, then any
   * method-level `@Tag` name a controller didn't already declare — description-
   * less, since a method's JSDoc is its operation description, not a tag
   * description. A controller tag no operation references (every method overrides
   * it) is dropped, so empty controllers don't leak a dangling tag.
   */
  getTags(): { name: string; description?: string }[] {
    return [...this.tags.entries()]
      .filter(([name]) => this.usedTagNames.has(name))
      .map(([name, description]) => (description ? { name, description } : { name }));
  }

  private processController(controller: ClassDeclaration): void {
    if (!isVisible(getScopes(getTags(controller)), this.activeScopes)) return;

    // @Controller and the route decorators each accept `string | string[]`; an
    // array prefix/path means the handler is mapped to several routes at once.
    const basePathArgs = this.stringArgs(controller.getDecorator('Controller'), 0);
    const basePaths = basePathArgs.length ? basePathArgs : [''];
    const controllerTagBag = getTags(controller);
    const tag =
      controllerTagBag.Tag?.[0] ?? (this.hooks.controllerTag ?? this.defaultTag)(controller);

    if (!this.tags.has(tag)) {
      const rawDesc = controller.getJsDocs()[0]?.getCommentText();
      const desc = rawDesc
        ? filterScopedComments(rawDesc, this.activeScopes, {
            itemPath: `${controller.getName() ?? '<anon>'} (tag)`,
            knownScopes: this.knownScopes,
          })
        : undefined;
      this.tags.set(tag, desc || undefined);
    }

    for (const method of controller.getInstanceMethods()) {
      if (!isVisible(getScopes(getTags(method)), this.activeScopes)) continue;

      const httpDecorator = method.getDecorators().find((d) => HTTP_METHODS[d.getName()]);
      if (!httpDecorator) continue;

      const httpMethod = HTTP_METHODS[httpDecorator.getName()];
      const routeArgs = this.stringArgs(httpDecorator, 0);
      const routePaths = routeArgs.length ? routeArgs : [''];
      const methodTag = getTags(method).Tag?.[0] ?? tag;

      // One operation per (controller prefix × route path × optional-param
      // expansion) combination. Each gets its own operationId (uniqueOperationId
      // de-dups) and its own path params, since placeholders can differ per path.
      for (const base of basePaths) {
        for (const route of routePaths) {
          const rawPath = this.joinPath(this.globalPrefix, base, route);
          for (const fullPath of this.expandRoutePaths(rawPath, controller, method)) {
            this.usedTagNames.add(methodTag);
            const templateParams = this.pathParamNames(fullPath);
            const operation = this.buildOperation(
              controller,
              method,
              httpMethod,
              methodTag,
              templateParams,
            );

            this.paths[fullPath] ??= {};
            this.paths[fullPath][httpMethod] = operation;
          }
        }
      }
    }
  }

  private buildOperation(
    controller: ClassDeclaration,
    method: MethodDeclaration,
    httpMethod: string,
    tag: string,
    pathParamNames: string[],
  ): Record<string, unknown> {
    const operation: Record<string, unknown> = {
      operationId: this.uniqueOperationId(tag, method.getName()),
      tags: [tag],
    };

    const summary = this.resolveSummary(controller, method, httpMethod);
    if (summary) operation.summary = summary;

    // `@Accept <type>` overrides the request body media type; `@ContentType
    // <type>` overrides the response media type. Both default to JSON.
    const methodTags = getTags(method);
    const responseMediaType = methodTags.ContentType?.[0] || DEFAULT_MEDIA_TYPE;

    const rawDesc = method.getJsDocs()[0]?.getCommentText();
    const desc = rawDesc
      ? filterScopedComments(rawDesc, this.activeScopes, {
          itemPath: `${controller.getName() ?? '<anon>'}.${method.getName()}`,
          knownScopes: this.knownScopes,
        })
      : undefined;
    if (desc) operation.description = desc;

    // Collect explicit @Param('name') schemas keyed by name, plus query/header
    // params in declaration order. Path params are emitted from the route
    // template below, not from this loop, so the spec can never reference a
    // `{param}` that has no parameter object.
    const explicitPathParams = new Map<string, OpenApiSchema>();
    const otherParameters: Record<string, unknown>[] = [];
    let bodyParam: ParameterDeclaration | undefined;

    for (const param of method.getParameters()) {
      const decorator = param
        .getDecorators()
        .find((d) => ['Param', 'Query', 'Body', 'Headers'].includes(d.getName()));
      if (!decorator) continue;

      switch (decorator.getName()) {
        case 'Param': {
          const name = this.stringArg(decorator, 0);
          // A @Param('name') whose name isn't in the route template can't be a
          // valid path parameter, so it's recorded here and only used if the
          // template actually declares it.
          if (name) explicitPathParams.set(name, this.paramSchema(decorator, param));
          break;
        }
        case 'Query':
          otherParameters.push(...this.buildQueryParameters(decorator, param));
          break;
        case 'Headers': {
          const headerName = this.stringArg(decorator, 0);
          if (headerName) {
            otherParameters.push({
              name: headerName,
              in: 'header',
              required: false,
              schema: { type: 'string' },
            });
          }
          break;
        }
        case 'Body':
          bodyParam = param;
          break;
      }
    }

    // File uploads (@UploadedFile/@UploadedFiles, named by their FileInterceptor)
    // become `format: binary` form fields, merged with any @Body() fields into a
    // single multipart schema. With a file present the request defaults to
    // multipart/form-data; `@Accept` still overrides it.
    const fileFields = this.collectFileFields(method);
    const acceptMediaType =
      methodTags.Accept?.[0] || (fileFields.length ? MULTIPART_MEDIA_TYPE : DEFAULT_MEDIA_TYPE);
    const requestBody = fileFields.length
      ? this.buildUploadRequestBody(bodyParam, fileFields, acceptMediaType)
      : bodyParam
        ? this.buildRequestBody(bodyParam, acceptMediaType)
        : undefined;

    // Every `{param}` in the route template must have a path-parameter entry, in
    // template order — even when the handler never binds it with @Param('name')
    // (e.g. it uses `@Param() all`, `@Req()`, or the name simply doesn't match).
    // Such placeholders default to `string`.
    const parameters: Record<string, unknown>[] = pathParamNames.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: explicitPathParams.get(name) ?? { type: 'string' },
    }));
    parameters.push(...otherParameters);

    if (parameters.length) operation.parameters = parameters;
    if (requestBody) operation.requestBody = requestBody;
    operation.responses = this.buildResponses(controller, method, httpMethod, responseMediaType);

    const security = this.buildSecurity(controller, method);
    if (security !== undefined) operation.security = security;

    return operation;
  }

  /**
   * The operation `summary`: a method-level `@Name` JSDoc tag (highest priority),
   * else the `endpointSummary` hook when it returns a value, else the default —
   * the method name humanized.
   */
  private resolveSummary(
    controller: ClassDeclaration,
    method: MethodDeclaration,
    httpMethod: string,
  ): string {
    const named = getTags(method).Name?.[0];
    if (named) return named;

    const defaultSummary = humanizeMethodName(method.getName());
    return (
      this.hooks.endpointSummary?.({ controller, method, httpMethod, defaultSummary }) ??
      defaultSummary
    );
  }

  private buildQueryParameters(
    decorator: Decorator,
    param: ParameterDeclaration,
  ): Record<string, unknown>[] {
    const argName = this.stringArg(decorator, 0);
    if (argName) {
      return [
        { name: argName, in: 'query', required: false, schema: this.paramSchema(decorator, param) },
      ];
    }

    // `@Query() dto: SomeDTO` -> expand DTO properties into individual query params.
    const className = AstIndex.symbolName(param.getType());
    const clazz = className ? this.index.getClass(className) : undefined;
    if (!clazz) return [];

    const members = this.schemaBuilder.buildMembers(clazz);
    return Object.entries(members.properties).map(([name, schema]) => ({
      name,
      in: 'query',
      required: members.required.includes(name),
      schema,
    }));
  }

  private buildRequestBody(
    param: ParameterDeclaration,
    mediaType: string,
  ): Record<string, unknown> {
    const schema = this.schemaBuilder.typeToSchema(param.getType());
    return { required: true, content: { [mediaType]: { schema } } };
  }

  /**
   * The file upload form fields of an endpoint. Names come from the method's
   * `@UseInterceptors` (`FileInterceptor('x')` → single, `FilesInterceptor('x')`
   * → array). When no recognized interceptor is present, falls back to
   * `@UploadedFile`/`@UploadedFiles` parameters — named by their string argument,
   * else the parameter name.
   */
  private collectFileFields(method: MethodDeclaration): { name: string; multiple: boolean }[] {
    const fromInterceptors = this.interceptorFileFields(method);
    if (fromInterceptors.length) return fromInterceptors;

    const fields: { name: string; multiple: boolean }[] = [];
    for (const param of method.getParameters()) {
      const dec = param
        .getDecorators()
        .find((d) => d.getName() === 'UploadedFile' || d.getName() === 'UploadedFiles');
      if (!dec) continue;
      fields.push({
        name: this.stringArg(dec, 0) ?? param.getName(),
        multiple: dec.getName() === 'UploadedFiles',
      });
    }
    return fields;
  }

  private interceptorFileFields(method: MethodDeclaration): { name: string; multiple: boolean }[] {
    const dec = method.getDecorator('UseInterceptors');
    if (!dec) return [];
    const fields: { name: string; multiple: boolean }[] = [];
    for (const arg of dec.getArguments()) {
      if (!Node.isCallExpression(arg)) continue;
      const fn = arg.getExpression().getText();
      const first = arg.getArguments()[0];
      if (!first || !Node.isStringLiteral(first)) continue;
      if (fn === 'FileInterceptor') fields.push({ name: first.getLiteralValue(), multiple: false });
      else if (fn === 'FilesInterceptor')
        fields.push({ name: first.getLiteralValue(), multiple: true });
    }
    return fields;
  }

  /**
   * Build a multipart request body merging the `@Body()` DTO's fields (inlined,
   * like `@Query() dto`) with the upload's `format: binary` file field(s).
   */
  private buildUploadRequestBody(
    bodyParam: ParameterDeclaration | undefined,
    fileFields: { name: string; multiple: boolean }[],
    mediaType: string,
  ): Record<string, unknown> {
    const properties: Record<string, OpenApiSchema> = {};
    const required: string[] = [];

    if (bodyParam) {
      const className = AstIndex.symbolName(bodyParam.getType());
      const clazz = className ? this.index.getClass(className) : undefined;
      if (clazz) {
        const members = this.schemaBuilder.buildMembers(clazz);
        Object.assign(properties, members.properties);
        required.push(...members.required);
      }
    }

    for (const file of fileFields) {
      const binary: OpenApiSchema = { type: 'string', format: 'binary' };
      properties[file.name] = file.multiple ? { type: 'array', items: binary } : binary;
      required.push(file.name);
    }

    const schema: OpenApiSchema = { type: 'object', properties };
    if (required.length) schema.required = required;
    return { required: true, content: { [mediaType]: { schema } } };
  }

  private buildResponses(
    controller: ClassDeclaration,
    method: MethodDeclaration,
    httpMethod: string,
    mediaType: string,
  ): Record<string, OpenApiResponse> {
    let returnType = method.getReturnType();
    if (AstIndex.symbolName(returnType) === 'Promise') {
      const args = returnType.getTypeArguments();
      if (args.length) returnType = args[0];
    }

    const responseSchema = this.computeResponseSchema(method, returnType);
    const status = this.responseStatus(method, httpMethod);

    const success: OpenApiResponse = { description: 'Successful response' };
    if (responseSchema !== undefined) {
      success.content = { [mediaType]: { schema: responseSchema } };
    }

    // Seed the success entry first, then layer `@Response <code> <description>`
    // tags on top. `??=` keeps the computed success entry authoritative and lets
    // the first tag win on a duplicate code; the body (`content`) is filled by
    // the `buildResponses` hook, not the tag.
    const responses: Record<string, OpenApiResponse> = { [status]: success };
    for (const line of getTags(method).Response ?? []) {
      const parsed = this.parseResponseTag(line);
      if (parsed) responses[parsed.code] ??= { description: parsed.description };
    }

    if (!this.hooks.buildResponses) return responses;
    const ctx = {
      controller,
      method,
      httpMethod,
      successStatus: status,
      typeToSchema: (t: Type) => this.schemaBuilder.typeToSchema(t),
    };
    return this.hooks.buildResponses(ctx, responses) ?? responses;
  }

  /**
   * Parse a `@Response <code> <description>` tag line. The first token is the
   * status code; the rest is the description. When the description is omitted,
   * fall back to the code's canonical HTTP reason phrase. Returns `undefined`
   * when the code isn't a number, so a malformed tag is skipped rather than
   * emitting an invalid status key.
   */
  private parseResponseTag(line: string): { code: string; description: string } | undefined {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d{3})\s*(.*)$/);
    if (!match) return undefined;
    const code = match[1];
    const description = match[2].trim() || this.reasonPhrase(code);
    return { code, description };
  }

  /**
   * Canonical HTTP reason phrase for a status code, derived from the
   * `HTTP_STATUS_CODES` member name (e.g. `404` → `Not Found`); else `Error`.
   */
  private reasonPhrase(code: string): string {
    const numeric = Number(code);
    const member = Object.keys(HTTP_STATUS_CODES).find((k) => HTTP_STATUS_CODES[k] === numeric);
    if (!member) return 'Error';
    return member
      .toLowerCase()
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /**
   * The success status code for an operation: an explicit `@HttpCode(...)` when
   * present — either a numeric literal (`@HttpCode(204)`) or an `HttpStatus`
   * member (`@HttpCode(HttpStatus.NO_CONTENT)`) — otherwise NestJS's default:
   * 201 for POST, 200 for every other verb.
   */
  private responseStatus(method: MethodDeclaration, httpMethod: string): string {
    const arg = method.getDecorator('HttpCode')?.getArguments()[0];
    if (arg) {
      if (Node.isNumericLiteral(arg)) return String(arg.getLiteralValue());
      if (Node.isPropertyAccessExpression(arg)) {
        const code = HTTP_STATUS_CODES[arg.getName()];
        if (code !== undefined) return String(code);
      }
    }
    return httpMethod === 'post' ? '201' : '200';
  }

  private computeResponseSchema(
    method: MethodDeclaration,
    returnType: Type,
  ): OpenApiSchema | undefined {
    const isEmpty = returnType.isVoid() || returnType.isUndefined();

    if (!this.hooks.buildSuccessResponseSchema) {
      return isEmpty ? undefined : this.schemaBuilder.typeToSchema(returnType);
    }

    return this.hooks.buildSuccessResponseSchema({
      method,
      returnType,
      returnTypeName: AstIndex.symbolName(returnType),
      returnTypeArgs: returnType.getTypeArguments(),
      defaultSchema: () => (isEmpty ? {} : this.schemaBuilder.typeToSchema(returnType)),
      typeToSchema: (t) => this.schemaBuilder.typeToSchema(t),
    });
  }

  private buildSecurity(
    controller: ClassDeclaration,
    method: MethodDeclaration,
  ): OpenApiSecurityRequirement[] | undefined {
    if (this.hooks.resolveSecurity) {
      return this.hooks.resolveSecurity({
        controller,
        method,
        registeredSchemes: this.registeredSchemes,
      });
    }

    // Default: every registered scheme applies (logical OR).
    if (this.registeredSchemes.length === 0) return undefined;
    return this.registeredSchemes.map((name) => ({ [name]: [] }));
  }

  private paramSchema(decorator: Decorator, param: ParameterDeclaration): OpenApiSchema {
    const argsText = decorator
      .getArguments()
      .map((a) => a.getText())
      .join(' ');
    if (argsText.includes('ParseUUIDPipe')) return { type: 'string', format: 'uuid' };
    if (argsText.includes('ParseIntPipe')) return { type: 'integer' };
    if (argsText.includes('ParseBoolPipe')) return { type: 'boolean' };
    return this.schemaBuilder.typeToSchema(param.getType());
  }

  private stringArg(decorator: Decorator | undefined, index: number): string | undefined {
    if (!decorator) return undefined;
    const arg = decorator.getArguments()[index];
    return arg && Node.isStringLiteral(arg) ? arg.getLiteralValue() : undefined;
  }

  /**
   * Read a decorator argument that may be a string literal or an array of string
   * literals (`@Get('a')` or `@Get(['a', 'b'])`), returning the distinct values.
   * Non-string and dynamic entries are skipped; the result is empty when absent.
   */
  private stringArgs(decorator: Decorator | undefined, index: number): string[] {
    if (!decorator) return [];
    const arg = decorator.getArguments()[index];
    if (!arg) return [];
    let values: string[] = [];
    if (Node.isStringLiteral(arg)) {
      values = [arg.getLiteralValue()];
    } else if (Node.isArrayLiteralExpression(arg)) {
      values = arg
        .getElements()
        .filter(Node.isStringLiteral)
        .map((el) => el.getLiteralValue());
    }
    return [...new Set(values)];
  }

  private defaultTag(controller: ClassDeclaration): string {
    const base = (controller.getName() ?? 'Default').replace(/Controller$/, '');
    return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  }

  private uniqueOperationId(tag: string, methodName: string): string {
    const base = `${tag.replace(/\s+/g, '')}_${methodName}`;
    let id = base;
    let counter = 2;
    while (this.usedOperationIds.has(id)) id = `${base}_${counter++}`;
    this.usedOperationIds.add(id);
    return id;
  }

  private joinPath(...parts: string[]): string {
    return ('/' + parts.filter(Boolean).join('/')).replace(/\/{2,}/g, '/');
  }

  /**
   * Turn a raw NestJS route (with `:params`) into the OpenAPI path(s) it maps to.
   *
   *  - An optional param (`:id?`) expands into the with/without pair, because
   *    OpenAPI path params are always required (`a/:id?` → `/a` and `/a/{id}`).
   *  - Constructs OpenAPI can't represent — inline regex (`:id(\d+)`), wildcards
   *    (`*`, `:splat*`), `+`/`*` modifiers, and more than one optional param —
   *    cause the route to be skipped with a warning.
   */
  private expandRoutePaths(
    rawPath: string,
    controller: ClassDeclaration,
    method: MethodDeclaration,
  ): string[] {
    const where = (): string => `${controller.getName() ?? '<anon>'}.${method.getName()}`;
    const skip = (reason: string): string[] => {
      console.warn(`[nestparser] Skipping route "${rawPath}" (${where()}): ${reason}`);
      return [];
    };

    if (/[*+()]/.test(rawPath)) {
      return skip(
        "unsupported path pattern (regex, wildcard or modifier). Only ':param' and optional ':param?' are handled.",
      );
    }

    const segments = rawPath.split('/').filter(Boolean);
    const optionalIdx = segments.flatMap((s, i) => (/^:[A-Za-z0-9_]+\?$/.test(s) ? [i] : []));
    if (optionalIdx.length > 1) {
      return skip("more than one optional ':param?' in a route is not supported.");
    }
    if (optionalIdx.length === 0) {
      return [this.toOpenApiPath('/' + segments.join('/'))];
    }

    // Exactly one optional: emit the route without that segment, and with it
    // present (the trailing `?` dropped so it's a normal required param).
    const i = optionalIdx[0];
    const without = segments.filter((_, idx) => idx !== i);
    const present = segments.map((s, idx) => (idx === i ? s.slice(0, -1) : s));
    return [
      this.toOpenApiPath('/' + without.join('/')),
      this.toOpenApiPath('/' + present.join('/')),
    ];
  }

  private toOpenApiPath(routePath: string): string {
    let out = routePath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  }

  /** Names of the `{param}` placeholders in an OpenAPI path, in order, deduped. */
  private pathParamNames(openApiPath: string): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const match of openApiPath.matchAll(/\{([^}]+)\}/g)) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }
}
