import {
  ClassDeclaration,
  Decorator,
  MethodDeclaration,
  Node,
  ParameterDeclaration,
  Type,
} from 'ts-morph';
import type { NestParserHooks } from '../config/types';
import type { OpenApiSchema, OpenApiSecurityRequirement } from '../types/openapi';
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
    return this.paths;
  }

  /**
   * Tag entries derived from each controller — name from `@ApiTags(...)` or the
   * default-tag hook, description from the controller class's JSDoc. First
   * controller wins when multiple share a tag name.
   */
  getTags(): { name: string; description?: string }[] {
    return [...this.tags.entries()].map(([name, description]) =>
      description ? { name, description } : { name },
    );
  }

  private processController(controller: ClassDeclaration): void {
    if (!isVisible(getScopes(getTags(controller)), this.activeScopes)) return;

    const basePath = this.stringArg(controller.getDecorator('Controller'), 0) ?? '';
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
      const routePath = this.stringArg(httpDecorator, 0) ?? '';
      const fullPath = this.toOpenApiPath(this.joinPath(this.globalPrefix, basePath, routePath));

      const methodTag = getTags(method).Tag?.[0] ?? tag;
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
    let requestBody: Record<string, unknown> | undefined;

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
          requestBody = this.buildRequestBody(param);
          break;
      }
    }

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
    operation.responses = this.buildResponses(method, httpMethod);

    const security = this.buildSecurity(controller, method);
    if (security !== undefined) operation.security = security;

    return operation;
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

  private buildRequestBody(param: ParameterDeclaration): Record<string, unknown> {
    const schema = this.schemaBuilder.typeToSchema(param.getType());
    return { required: true, content: { 'application/json': { schema } } };
  }

  private buildResponses(method: MethodDeclaration, httpMethod: string): Record<string, unknown> {
    let returnType = method.getReturnType();
    if (AstIndex.symbolName(returnType) === 'Promise') {
      const args = returnType.getTypeArguments();
      if (args.length) returnType = args[0];
    }

    const responseSchema = this.computeResponseSchema(method, returnType);
    const status = httpMethod === 'post' ? '201' : '200';

    const response: Record<string, unknown> = { description: 'Successful response' };
    if (responseSchema !== undefined) {
      response.content = { 'application/json': { schema: responseSchema } };
    }
    return { [status]: response };
  }

  private computeResponseSchema(
    method: MethodDeclaration,
    returnType: Type,
  ): OpenApiSchema | undefined {
    const isEmpty = returnType.isVoid() || returnType.isUndefined();

    if (!this.hooks.buildResponseSchema) {
      return isEmpty ? undefined : this.schemaBuilder.typeToSchema(returnType);
    }

    return this.hooks.buildResponseSchema({
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
