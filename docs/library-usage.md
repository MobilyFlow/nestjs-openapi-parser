# Library usage

```ts
import {
  parseNestProject,
  loadConfig,
  defineConfig,
  validateDocument,
  filterScopedComments,
  getScopes,
  getTags,
  isVisible,
  parseScopeList,
} from 'nestjs-openapi-parser';

import type {
  NestParserConfig,
  NestParserHooks,
  SuccessResponseSchemaContext,
  ResponsesContext,
  SecurityContext,
  OpenApiDocument,
  OpenApiSchema,
} from 'nestjs-openapi-parser';

// Auto-discover + load nestparser.config.* from disk
const { config, filePath } = await loadConfig({ projectRoot });

// Or build the config inline
const inline = defineConfig({ openapi: { title: 'X', version: '1.0' } });

// Generate the document — async, and self-validates (throws on an invalid spec)
const doc: OpenApiDocument = await parseNestProject({ projectRoot, config });

// Or validate any document yourself against the OpenAPI schema
const { valid, errors } = await validateDocument(doc);
```

Public exports live in [`src/lib.ts`](../src/lib.ts): `parseNestProject`, `loadConfig`, `defineConfig`, the scope helpers (`getTags`, `getScopes`, `isVisible`, `filterScopedComments`, `parseScopeList`), and the relevant TypeScript types.

The internal builders (`AstIndex`, `SchemaBuilder`, `PathBuilder`) are also exported if you need fine-grained control, but the stable surface is `parseNestProject` + `loadConfig`.
