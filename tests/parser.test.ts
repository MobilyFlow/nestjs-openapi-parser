import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AstIndex, SchemaBuilder, loadConfig, parseNestProject } from '../src/lib';
import type { ModelConstructor, NestParserConfig } from '../src/lib';
import type { OpenApiDocument } from '../src/types/openapi';

const FIXTURE = path.resolve(__dirname, 'fixtures/example-app');

async function loadFixtureConfig(): Promise<NestParserConfig> {
  const { config } = await loadConfig({ projectRoot: FIXTURE });
  return config;
}

async function buildFixtureDocument(
  overrides: Partial<NestParserConfig> = {},
): Promise<OpenApiDocument> {
  const config = { ...(await loadFixtureConfig()), ...overrides };
  return parseNestProject({ projectRoot: FIXTURE, config });
}

// Stub classes used only as a name-based handle for the parser's AST lookup.
// They must match a class name actually defined in the fixture's source tree.
class AuditEvent {}
class ListPostsQueryDto {}

// One snapshot file per scope variant — proves the spec stays stable across
// every documentation flavor we ship from the same source.
const SNAPSHOT_VARIANTS: { label: string; scopes?: string[]; file: string }[] = [
  { label: 'no-scope', file: 'openapi.snap.json' },
  { label: 'admin', scopes: ['admin'], file: 'openapi.admin.snap.json' },
  {
    label: 'internal+admin',
    scopes: ['internal', 'admin'],
    file: 'openapi.internal-admin.snap.json',
  },
];

describe('parseNestProject (library API)', () => {
  describe.each(SNAPSHOT_VARIANTS)('snapshot variant: $label', ({ scopes, file }) => {
    it(`matches __snapshots__/${file}`, async () => {
      const document = await buildFixtureDocument(scopes ? { scopes } : {});
      await expect(JSON.stringify(document, null, 2) + '\n').toMatchFileSnapshot(
        `./__snapshots__/${file}`,
      );
    });
  });

  it('strips @Exclude properties from emitted schemas', async () => {
    const document = await buildFixtureDocument();
    const user = document.components?.schemas?.User as
      | { properties: Record<string, unknown> }
      | undefined;
    expect(user).toBeDefined();
    expect(user!.properties).not.toHaveProperty('passwordHash');
    expect(user!.properties).toHaveProperty('email');
  });

  it('marks @Public() endpoints with empty security and others with bearerAuth', async () => {
    const document = await buildFixtureDocument();
    const healthGet = document.paths['/api/health'].get as { security: unknown };
    const usersGet = document.paths['/api/users'].get as { security: unknown };
    const authLogin = document.paths['/api/auth/login'].post as { security: unknown };

    expect(healthGet.security).toEqual([]);
    expect(authLogin.security).toEqual([]);
    expect(usersGet.security).toEqual([{ bearerAuth: [] }]);
  });

  it('wraps every response in the configured { success, message, data } envelope', async () => {
    const document = await buildFixtureDocument();
    const findOne = document.paths['/api/users/{id}'].get as {
      responses: Record<
        string,
        { content: { 'application/json': { schema: Record<string, unknown> } } }
      >;
    };
    const schema = findOne.responses['200'].content['application/json'].schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['success', 'message', 'data']);
    expect(schema.required).toEqual(['success', 'message', 'data']);
  });

  it('treats PaginatedResponse<T> via the wrapper branch of the envelope hook', async () => {
    const document = await buildFixtureDocument();
    const listUsers = document.paths['/api/users'].get as {
      responses: Record<
        string,
        { content: { 'application/json': { schema: Record<string, unknown> } } }
      >;
    };
    const schema = listUsers.responses['200'].content['application/json'].schema as {
      properties: Record<string, { type?: string }>;
    };
    expect(schema.properties.data?.type).toBe('array');
    expect(schema.properties.pagination?.type).toBe('object');
  });

  it('emits a path-level UUID schema for @Param(":id", ParseUUIDPipe)', async () => {
    const document = await buildFixtureDocument();
    const findOne = document.paths['/api/users/{id}'].get as {
      parameters: { name: string; in: string; schema: Record<string, unknown> }[];
    };
    const idParam = findOne.parameters.find((p) => p.name === 'id' && p.in === 'path');
    expect(idParam?.schema).toEqual({ type: 'string', format: 'uuid' });
  });

  it('expands @Query() DTO into individual query parameters', async () => {
    const document = await buildFixtureDocument();
    const listPosts = document.paths['/api/posts'].get as {
      parameters: { name: string; in: string }[];
    };
    const queryNames = listPosts.parameters
      .filter((p) => p.in === 'query')
      .map((p) => p.name)
      .sort();
    expect(queryNames).toEqual(['authorId', 'limit', 'offset', 'status']);
  });

  it('emits controller JSDoc as the matching tag description', async () => {
    const document = await buildFixtureDocument();
    const auth = document.tags?.find((t) => t.name === 'Auth');
    expect(auth?.description).toBe('This controller manage auth');

    // Controllers without JSDoc still appear as tags but carry no description.
    const users = document.tags?.find((t) => t.name === 'Users');
    expect(users).toBeDefined();
    expect(users?.description).toBeUndefined();
  });

  it('honors @Tag JSDoc to override the derived default tag name', async () => {
    const document = await buildFixtureDocument();
    expect(document.tags?.find((t) => t.name === 'System Health')).toBeDefined();
    expect(document.tags?.find((t) => t.name === 'Health')).toBeUndefined();
    expect((document.paths['/api/health'].get as { tags: string[] }).tags).toEqual([
      'System Health',
    ]);
  });

  it('resolves UpdateUserDto via PartialType(CreateUserDto) with all fields optional', async () => {
    const document = await buildFixtureDocument();
    const update = document.components?.schemas?.UpdateUserDto as
      | { properties: Record<string, unknown>; required?: string[] }
      | undefined;
    expect(update).toBeDefined();
    expect(update!.properties).toHaveProperty('email');
    expect(update!.properties).toHaveProperty('role');
    expect(update!.required ?? []).toEqual([]);
  });

  describe('schema reachability', () => {
    it('omits classes that no endpoint reaches', async () => {
      const document = await buildFixtureDocument();
      const schemas = Object.keys(document.components?.schemas ?? {});
      // ListPostsQueryDto is consumed only as `@Query()` expansion — never
      // surfaces as a ref — so it must not be in components.schemas.
      expect(schemas).not.toContain('ListPostsQueryDto');
      // Orphan classes are absent.
      expect(schemas).not.toContain('AuditEvent');
      expect(schemas).not.toContain('AuditActor');
    });

    it('emits a schema for every class transitively reached from an endpoint', async () => {
      const document = await buildFixtureDocument();
      const schemas = document.components?.schemas ?? {};
      // Reachable directly via controller return types / @Body / PartialType:
      expect(schemas).toHaveProperty('User');
      expect(schemas).toHaveProperty('BlogPost');
      expect(schemas).toHaveProperty('CreateUserDto');
      expect(schemas).toHaveProperty('UpdateUserDto');
      expect(schemas).toHaveProperty('CreatePostDto');
      expect(schemas).toHaveProperty('LoginDto');
      expect(schemas).toHaveProperty('LoginResponseDto');
      expect(schemas).toHaveProperty('HealthStatusDto');
    });
  });

  describe('additionalModels', () => {
    it('force-includes a class even when no endpoint references it', async () => {
      const document = await buildFixtureDocument({ additionalModels: [ListPostsQueryDto] });
      expect(document.components?.schemas).toHaveProperty('ListPostsQueryDto');
    });

    it('pulls in transitively-referenced classes from an added model', async () => {
      const document = await buildFixtureDocument({ additionalModels: [AuditEvent] });
      // AuditEvent has `actor: AuditActor` — both must be emitted.
      expect(document.components?.schemas).toHaveProperty('AuditEvent');
      expect(document.components?.schemas).toHaveProperty('AuditActor');
      // Sanity: still doesn't pull unrelated orphans.
      expect(document.components?.schemas).not.toHaveProperty('ListPostsQueryDto');
    });

    it('throws when an additionalModels entry is not in the source tree', async () => {
      class NotInProject {}
      const config = await loadFixtureConfig();
      expect(() =>
        parseNestProject({
          projectRoot: FIXTURE,
          config: { ...config, additionalModels: [NotInProject as ModelConstructor] },
        }),
      ).toThrow(/NotInProject/);
    });
  });
});

describe('output ordering', () => {
  // The source tree is walked in name-sorted order (not raw fs.readdirSync
  // order), so paths, tags and schemas come out identical on every platform.
  // These hard-coded expectations are the cross-platform determinism contract:
  // a developer on ext4 must produce exactly this order too.
  it('emits paths, tags and schemas in a stable, filesystem-independent order', async () => {
    const document = await buildFixtureDocument();
    expect(Object.keys(document.paths)).toEqual([
      '/api/auth/login',
      '/api/health',
      '/api/posts',
      '/api/users',
      '/api/users/{id}',
    ]);
    expect(document.tags?.map((t) => t.name)).toEqual(['Auth', 'System Health', 'Posts', 'Users']);
    expect(Object.keys(document.components?.schemas ?? {})).toEqual([
      'LoginDto',
      'LoginResponseDto',
      'HealthStatusDto',
      'CreatePostDto',
      'BlogPost',
      'User',
      'CreateUserDto',
      'UpdateUserDto',
    ]);
  });

  it('keeps model fields in their source-declaration order', async () => {
    const document = await buildFixtureDocument();
    const blogPost = document.components?.schemas?.BlogPost as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(blogPost.properties)).toEqual([
      'id',
      'title',
      'body',
      'authorId',
      'status',
      'publishedAt',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('orders inherited fields parent-first, then own — each in source order', () => {
    // The fixture has no real `extends` chain, so spin up a throwaway project.
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-order-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs', strict: false },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'models.ts'),
        [
          'export class Base {',
          '  alpha!: string;',
          '  beta!: number;',
          '}',
          'export class Middle extends Base {',
          '  gamma!: boolean;',
          '}',
          'export class Child extends Middle {',
          '  delta!: string;',
          '  epsilon?: number;',
          '}',
          '',
        ].join('\n'),
      );

      const index = new AstIndex({
        projectRoot: tmp,
        project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
      });
      const child = index.getClass('Child');
      expect(child).toBeDefined();

      const members = new SchemaBuilder(index).buildMembers(child!);
      // Grandparent (Base) → parent (Middle) → own (Child), declaration order within each.
      expect(Object.keys(members.properties)).toEqual([
        'alpha',
        'beta',
        'gamma',
        'delta',
        'epsilon',
      ]);
      // `epsilon?` is optional; the rest are required, in the same parent-first order.
      expect(members.required).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('path parameters from the route template', () => {
  type PathParam = { name: string; in: string; required: boolean; schema: Record<string, unknown> };
  const paramsOf = (doc: OpenApiDocument, path: string): PathParam[] =>
    ((doc.paths[path]?.get as { parameters?: PathParam[] })?.parameters ?? []).filter(
      (p) => p.in === 'path',
    );

  // Build a throwaway controller and run the full pipeline over it.
  function buildCatsDoc(): OpenApiDocument {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-pathparam-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'commonjs',
            experimentalDecorators: true,
            strict: false,
          },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'cats.controller.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          'declare function Param(name: string): ParameterDecorator;',
          '',
          "@Controller('cats')",
          'export class CatsController {',
          '  // `:id` with no @Param at all — must still produce an {id} path param.',
          "  @Get(':id')",
          '  findOne(): void {}',
          '',
          '  // Multiple placeholders, none bound — both must appear, in template order.',
          "  @Get(':from/:to')",
          '  range(): void {}',
          '',
          '  // Explicit @Param that matches the template.',
          "  @Get('named/:slug')",
          "  bySlug(@Param('slug') _slug: string): void {}",
          '',
          "  // @Param('wrong') doesn't match the template — ignored; {id} still emitted.",
          "  @Get(':id/detail')",
          "  detail(@Param('wrong') _x: string): void {}",
          '}',
          '',
        ].join('\n'),
      );

      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Cats', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('synthesizes a string path param when the route declares one but no @Param binds it', () => {
    const doc = buildCatsDoc();
    expect(paramsOf(doc, '/cats/{id}')).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('emits every placeholder, in template order, for multi-param routes', () => {
    const doc = buildCatsDoc();
    expect(paramsOf(doc, '/cats/{from}/{to}')).toEqual([
      { name: 'from', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'to', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('uses the explicit @Param schema when its name matches the template', () => {
    const doc = buildCatsDoc();
    expect(paramsOf(doc, '/cats/named/{slug}')).toEqual([
      { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('ignores a @Param whose name is absent from the template, still emitting the placeholder', () => {
    const doc = buildCatsDoc();
    const params = paramsOf(doc, '/cats/{id}/detail');
    expect(params.map((p) => p.name)).toEqual(['id']);
    expect(params[0].schema).toEqual({ type: 'string' });
  });
});
