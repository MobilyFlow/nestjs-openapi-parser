import fs from 'node:fs';
import path from 'node:path';
import type { NestParserConfig, PagesConfig } from '../config/types';
import type { OpenApiDocument, OpenApiSecurityScheme, OpenApiTagGroup } from '../types/openapi';
import { validateDocument } from '../validate';
import { AstIndex } from './ast-index';
import { PathBuilder } from './path-builder';
import { SchemaBuilder } from './schema-builder';
import { getScopes, getTags, isVisible } from './tags';

export { AstIndex, PathBuilder, SchemaBuilder };

export interface ParseNestProjectOptions {
  projectRoot: string;
  config: NestParserConfig;
}

/**
 * Build an OpenAPI 3.0.3 document from a NestJS project's TypeScript source.
 * Pure static analysis — no app boot, no decorator reflection.
 *
 * The produced document is validated against the OpenAPI 3.x schema before it is
 * returned; an invalid document throws (it indicates a parser/config bug rather
 * than something the caller should silently ship). This is why the function is
 * async — schema validation runs through `@seriousme/openapi-schema-validator`.
 */
export async function parseNestProject(options: ParseNestProjectOptions): Promise<OpenApiDocument> {
  const { projectRoot, config } = options;

  const index = new AstIndex({
    projectRoot,
    project: config.project,
    conventions: config.conventions,
  });

  const activeScopes = new Set(config.scopes ?? []);
  // Scope vocabulary: every `@Scope` declared in the source plus the active
  // scopes. Only these names are treated as `<scope>…</scope>` description
  // fragments — ordinary angle-bracket prose passes through untouched.
  const knownScopes = new Set<string>([...index.getDeclaredScopes(), ...activeScopes]);
  const schemaBuilder = new SchemaBuilder(index, { activeScopes, knownScopes });

  for (const klass of config.additionalModels ?? []) {
    const name = klass.name;
    const astClass = index.getClass(name);
    if (!astClass) {
      throw new Error(
        `additionalModels: class "${name}" was not found in the project source tree. ` +
          `Make sure it is defined in a .ts file under the configured rootDir.`,
      );
    }
    const classScopes = getScopes(getTags(astClass));
    if (!isVisible(classScopes, activeScopes)) {
      throw new Error(
        `additionalModels: class "${name}" has @Scope ${formatScopes(classScopes)} ` +
          `which doesn't match the active scopes ${formatScopes(activeScopes)}. ` +
          `Remove it from additionalModels or add a matching scope.`,
      );
    }
    schemaBuilder.registerRef(name);
  }

  // Drop null/undefined entries so a scheme can be declared conditionally
  // without leaking an empty key into the output or the default security policy.
  const securitySchemes = definedSecuritySchemes(config.openapi.securitySchemes);
  const registeredSchemes = Object.keys(securitySchemes);

  const pathBuilder = new PathBuilder(index, schemaBuilder, {
    globalPrefix: config.project?.globalPrefix,
    hooks: config.hooks,
    registeredSchemes,
    activeScopes,
    knownScopes,
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
      ...(registeredSchemes.length > 0 ? { securitySchemes } : {}),
    },
  };

  if (config.openapi.servers && config.openapi.servers.length > 0) {
    document.servers = config.openapi.servers;
  }

  if (tags.length > 0) {
    document.tags = tags;
  }

  applyPages(document, projectRoot, config.pages, tags);

  const { valid, errors } = await validateDocument(document);
  if (!valid) {
    throw new Error(
      `Generated OpenAPI document failed schema validation:\n${errors
        .map((e) => `  - ${e}`)
        .join('\n')}`,
    );
  }

  return document;
}

function formatScopes(scopes: Set<string>): string {
  return scopes.size === 0 ? '{}' : `{${[...scopes].join(', ')}}`;
}

/** Security schemes with `null`/`undefined` entries removed. */
function definedSecuritySchemes(
  schemes: Record<string, OpenApiSecurityScheme | null | undefined> | undefined,
): Record<string, OpenApiSecurityScheme> {
  const out: Record<string, OpenApiSecurityScheme> = {};
  for (const [name, scheme] of Object.entries(schemes ?? {})) {
    if (scheme != null) out[name] = scheme;
  }
  return out;
}

/**
 * Emit the configured Markdown pages as standalone, operation-less tags and wrap
 * the whole document in `x-tagGroups` so Scalar/Redoc renders the pages first
 * (right under the Introduction). Because `x-tagGroups` hides any ungrouped tag,
 * the API's own operation tags are gathered into a second group.
 */
function applyPages(
  document: OpenApiDocument,
  projectRoot: string,
  pages: PagesConfig | undefined,
  operationTags: { name: string }[],
): void {
  if (!pages || pages.files.length === 0) return;

  const pageTags = pages.files.map((file) => {
    const { title, content } = readPage(path.resolve(projectRoot, file));
    return { name: title, description: content };
  });

  // Pages render first; the existing operation tags keep their order after them.
  document.tags = [...pageTags, ...(document.tags ?? [])];

  // `x-tagGroups` is opt-in: only when a section name is given. Without one the
  // pages just lead the flat tag list — no "Documentation"/"API" headers, and no
  // need to corral the API's own tags (x-tagGroups would otherwise hide any
  // ungrouped tag). A missing counterpart name falls back to its default.
  if (pages.group === undefined && pages.apiGroup === undefined) return;

  const tagGroups: OpenApiTagGroup[] = [
    { name: pages.group ?? 'Documentation', tags: pageTags.map((t) => t.name) },
  ];
  if (operationTags.length > 0) {
    tagGroups.push({ name: pages.apiGroup ?? 'API', tags: operationTags.map((t) => t.name) });
  }
  document['x-tagGroups'] = tagGroups;
}

/**
 * Read a Markdown page. When the first line is an ATX heading (`# Title`), that
 * is the title and the line is dropped from the content (the tag name already
 * shows it, so keeping it would render the title twice). Otherwise the title is
 * the file's base name without extension and the body is kept whole. The content
 * is `trimStart`ed either way.
 */
function readPage(filePath: string): { title: string; content: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`pages: Markdown file not found or unreadable: ${filePath}`);
  }
  const lines = raw.split('\n');
  const heading = /^#{1,6}\s+(.+?)\s*$/.exec(lines[0]?.trim() ?? '');
  const title = heading ? heading[1].trim() : path.basename(filePath).replace(/\.[^.]+$/, '');
  const content = heading ? lines.slice(1).join('\n') : raw;
  return { title, content: content.trimStart() };
}
