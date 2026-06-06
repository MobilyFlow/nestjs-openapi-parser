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
import { getScopes, getTags, isVisible } from './tags';

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

  constructor(
    private readonly index: AstIndex,
    private readonly schemaBuilder: SchemaBuilder,
    options: PathBuilderOptions = {},
  ) {
    this.globalPrefix = options.globalPrefix ?? '';
    this.hooks = options.hooks ?? {};
    this.registeredSchemes = options.registeredSchemes ?? [];
    this.activeScopes = options.activeScopes ?? new Set();
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
    const defaultTag = (this.hooks.controllerTag ?? this.defaultTag)(controller);
    const tag = this.stringArg(controller.getDecorator('ApiTags'), 0) ?? defaultTag;

    if (!this.tags.has(tag)) {
      this.tags.set(tag, controller.getJsDocs()[0]?.getCommentText());
    }

    for (const method of controller.getInstanceMethods()) {
      if (!isVisible(getScopes(getTags(method)), this.activeScopes)) continue;

      const httpDecorator = method.getDecorators().find((d) => HTTP_METHODS[d.getName()]);
      if (!httpDecorator) continue;

      const httpMethod = HTTP_METHODS[httpDecorator.getName()];
      const routePath = this.stringArg(httpDecorator, 0) ?? '';
      const fullPath = this.toOpenApiPath(this.joinPath(this.globalPrefix, basePath, routePath));

      const methodTag = this.stringArg(method.getDecorator('ApiTags'), 0) ?? tag;
      const operation = this.buildOperation(controller, method, httpMethod, methodTag);

      this.paths[fullPath] ??= {};
      this.paths[fullPath][httpMethod] = operation;
    }
  }

  private buildOperation(
    controller: ClassDeclaration,
    method: MethodDeclaration,
    httpMethod: string,
    tag: string,
  ): Record<string, unknown> {
    const operation: Record<string, unknown> = {
      operationId: this.uniqueOperationId(tag, method.getName()),
      tags: [tag],
    };

    const desc = method.getJsDocs()[0]?.getCommentText();
    if (desc) operation.description = desc;

    const parameters: Record<string, unknown>[] = [];
    let requestBody: Record<string, unknown> | undefined;

    for (const param of method.getParameters()) {
      const decorator = param
        .getDecorators()
        .find((d) => ['Param', 'Query', 'Body', 'Headers'].includes(d.getName()));
      if (!decorator) continue;

      switch (decorator.getName()) {
        case 'Param': {
          const name = this.stringArg(decorator, 0);
          if (name) {
            parameters.push({
              name,
              in: 'path',
              required: true,
              schema: this.paramSchema(decorator, param),
            });
          }
          break;
        }
        case 'Query':
          parameters.push(...this.buildQueryParameters(decorator, param));
          break;
        case 'Headers': {
          const headerName = this.stringArg(decorator, 0);
          if (headerName) {
            parameters.push({
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
    return (controller.getName() ?? 'Default').replace(/Controller$/, '');
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
}
