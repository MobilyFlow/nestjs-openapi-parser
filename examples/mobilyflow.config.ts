/**
 * Reference config: reproduces the MobilyFlow POC (docs/scripts) behavior with
 * the published parser engine. Copy into your project root as
 * `nestparser.config.ts`.
 */
import { Node } from 'ts-morph';
import { defineConfig } from '../src/lib';

export default defineConfig({
  openapi: {
    title: 'MobilyFlow',
    version: '1.0',
    servers: [{ url: 'http://localhost:3000' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKey: { type: 'apiKey', in: 'header', name: 'Authorization' },
    },
  },

  project: {
    tsConfigFilePath: 'tsconfig.json',
    rootDir: 'src',
    globalPrefix: 'v1',
  },

  hooks: {
    // ─── Response envelope ─────────────────────────────────────────────────
    // Every endpoint returns `{ success, data, ... }` via a global interceptor.
    // PaginatedResponse<T> and ResponseWithFields<T> are special-cased.
    buildResponseSchema: ({ returnType, returnTypeName, defaultSchema }) => {
      const properties: Record<string, unknown> = { success: { type: 'boolean' } };
      const required = ['success'];
      let additionalProperties = false;

      if (returnTypeName === 'PaginatedResponse') {
        properties.data = { type: 'array', items: { type: 'object' } };
        properties.pagination = {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
          required: ['total', 'limit', 'offset'],
        };
        required.push('data', 'pagination');
      } else if (returnTypeName === 'ResponseWithFields') {
        properties.data = { type: 'object' };
        required.push('data');
        additionalProperties = true;
      } else if (!returnType.isVoid() && !returnType.isUndefined()) {
        properties.data = defaultSchema();
        required.push('data');
      }

      const schema: Record<string, unknown> = { type: 'object', properties, required };
      if (additionalProperties) schema.additionalProperties = true;
      return schema;
    },

    // ─── Auth ──────────────────────────────────────────────────────────────
    // Read `@AuthParams({ public, sources })`. Each field falls back independently
    // from method to class. Map Source.USER -> bearerAuth, else -> apiKey.
    resolveSecurity: ({ controller, method }) => {
      const methodAuth = readAuthParams(method.getDecorator('AuthParams'));
      const classAuth = readAuthParams(controller.getDecorator('AuthParams'));

      const isPublic = methodAuth?.public ?? classAuth?.public ?? false;
      if (isPublic) return [];

      const sources = methodAuth?.sources ?? classAuth?.sources;
      const schemes = new Set<string>();
      if (!sources || sources.length === 0) {
        schemes.add('bearerAuth');
        schemes.add('apiKey');
      } else {
        for (const source of sources) {
          schemes.add(source === 'USER' ? 'bearerAuth' : 'apiKey');
        }
      }

      return [...schemes].map((scheme) => ({ [scheme]: [] }));
    },
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface AuthParamsLiteral {
  public?: boolean;
  sources?: string[];
}

function readAuthParams(
  decorator: ReturnType<import('ts-morph').ClassDeclaration['getDecorator']>,
): AuthParamsLiteral | undefined {
  if (!decorator) return undefined;
  const arg = decorator.getArguments()[0];
  if (!arg || !Node.isObjectLiteralExpression(arg)) return {};

  const result: AuthParamsLiteral = {};

  const publicProp = arg.getProperty('public');
  if (publicProp && Node.isPropertyAssignment(publicProp)) {
    result.public = publicProp.getInitializer()?.getText() === 'true';
  }

  const sourcesProp = arg.getProperty('sources');
  if (sourcesProp && Node.isPropertyAssignment(sourcesProp)) {
    const initializer = sourcesProp.getInitializer();
    if (initializer && Node.isArrayLiteralExpression(initializer)) {
      result.sources = initializer.getElements().map((el) => el.getText().split('.').pop()!);
    }
  }

  return result;
}
