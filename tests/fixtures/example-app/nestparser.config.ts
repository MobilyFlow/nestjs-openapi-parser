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

  // Force-include orphan models no endpoint reaches: the `MaintenanceWindow`
  // interface (string form is the only way to pin a non-class model), and the
  // `ApiError` body referenced by the `buildResponses` hook for error codes.
  additionalModels: [
    'src/health/system-status.ts#MaintenanceWindow',
    'src/common/api-error.ts#ApiError',
  ],

  // Standalone Markdown page rendered ahead of the API reference. `group`/
  // `apiGroup` opt into grouped `x-tagGroups` navigation (omit both for a flat,
  // pages-first tag list).
  pages: {
    files: ['docs/getting-started.md'],
    group: 'Documentation',
    apiGroup: 'API',
  },

  hooks: {
    // Global success-response envelope: { success, message, data?, pagination? }.
    buildSuccessResponseSchema: ({ returnType, returnTypeName, defaultSchema }) => {
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

    // Attach error bodies. `@Response` tags seed status + description; here we
    // fill in `content` (a $ref to the force-included ApiError) for every error
    // code, and add a blanket 401 to secured endpoints.
    buildResponses: ({ controller, method }, responses) => {
      const errorBody = { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } };
      for (const [code, response] of Object.entries(responses)) {
        if (Number(code) >= 400 && !response.content) response.content = errorBody;
      }

      const isPublic = !!method.getDecorator('Public') || !!controller.getDecorator('Public');
      if (!isPublic) responses['401'] ??= { description: 'Unauthorized', content: errorBody };

      return responses;
    },
  },
});
