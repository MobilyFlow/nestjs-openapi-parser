import { defineConfig } from '../../../src/lib';

export default defineConfig({
  openapi: {
    title: 'Example API',
    version: '1.0.0',
    description: 'Self-contained fixture used by the nestparser test suite.',
    servers: [{ url: 'http://localhost:3000' }],
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },

  project: {
    tsConfigFilePath: 'tsconfig.json',
    rootDir: 'src',
    globalPrefix: 'api',
  },

  // Standalone Markdown page rendered ahead of the API reference. `group`/
  // `apiGroup` opt into grouped `x-tagGroups` navigation (omit both for a flat,
  // pages-first tag list).
  pages: {
    files: ['docs/getting-started.md'],
    group: 'Documentation',
    apiGroup: 'API',
  },

  hooks: {
    // Global response envelope: { success, message, data?, pagination? }.
    buildResponseSchema: ({ returnType, returnTypeName, defaultSchema }) => {
      const isEmpty = returnType.isVoid() || returnType.isUndefined();
      const properties: Record<string, unknown> = {
        success: { type: 'boolean' },
        message: { type: 'string' },
      };
      const required = ['success', 'message'];

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
      } else if (!isEmpty) {
        properties.data = defaultSchema();
        required.push('data');
      }

      return { type: 'object', properties, required };
    },

    // Endpoints with @Public() (on the method or its controller) are
    // unauthenticated; everything else requires bearerAuth.
    resolveSecurity: ({ controller, method }) => {
      const isPublic = !!method.getDecorator('Public') || !!controller.getDecorator('Public');
      return isPublic ? [] : [{ bearerAuth: [] }];
    },
  },
});
