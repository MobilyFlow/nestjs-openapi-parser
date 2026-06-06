import type { NestParserConfig } from '../config/types';
import type { OpenApiDocument } from '../types/openapi';
import { AstIndex } from './ast-index';
import { PathBuilder } from './path-builder';
import { SchemaBuilder } from './schema-builder';

export { AstIndex, PathBuilder, SchemaBuilder };

export interface ParseNestProjectOptions {
  projectRoot: string;
  config: NestParserConfig;
}

/**
 * Build an OpenAPI 3.0.3 document from a NestJS project's TypeScript source.
 * Pure static analysis — no app boot, no decorator reflection.
 */
export function parseNestProject(options: ParseNestProjectOptions): OpenApiDocument {
  const { projectRoot, config } = options;

  const index = new AstIndex({
    projectRoot,
    project: config.project,
    conventions: config.conventions,
    hooks: { isDto: config.hooks?.isDto },
  });

  const schemaBuilder = new SchemaBuilder(index);

  for (const klass of config.additionalModels ?? []) {
    const name = klass.name;
    if (!index.hasClass(name)) {
      throw new Error(
        `additionalModels: class "${name}" was not found in the project source tree. ` +
          `Make sure it is defined in a .ts file under the configured rootDir.`,
      );
    }
    schemaBuilder.registerRef(name);
  }

  const registeredSchemes = Object.keys(config.openapi.securitySchemes ?? {});

  const pathBuilder = new PathBuilder(index, schemaBuilder, {
    globalPrefix: config.project?.globalPrefix,
    hooks: config.hooks,
    registeredSchemes,
  });
  const paths = pathBuilder.build();
  const tags = pathBuilder.getTags();

  // Flush the schema worklist — paths may have registered extra refs.
  schemaBuilder.build();

  const document: OpenApiDocument = {
    openapi: '3.0.3',
    info: {
      title: config.openapi.title,
      version: config.openapi.version,
      ...(config.openapi.description ? { description: config.openapi.description } : {}),
      ...config.openapi.info,
    },
    paths,
    components: {
      schemas: schemaBuilder.getSchemas(),
      ...(config.openapi.securitySchemes
        ? { securitySchemes: config.openapi.securitySchemes }
        : {}),
    },
  };

  if (config.openapi.servers && config.openapi.servers.length > 0) {
    document.servers = config.openapi.servers;
  }

  if (tags.length > 0) {
    document.tags = tags;
  }

  return document;
}
