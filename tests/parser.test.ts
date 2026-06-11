import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AstIndex, SchemaBuilder, loadConfig, parseNestProject } from '../src/lib';
import type { ModelConstructor, NestParserConfig, PagesConfig } from '../src/lib';
import type { OpenApiDocument } from '../src/types/openapi';

// parseNestProject self-validates via a native dynamic import of an ESM-only
// package that vitest's VM can't host. Stub it for these in-process tests; the
// real validation runs in a real Node process via the CLI tests (cli.test.ts).
vi.mock('../src/validate', () => ({
  validateDocument: async () => ({ valid: true, errors: [] }),
}));

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
      await expect(
        parseNestProject({
          projectRoot: FIXTURE,
          config: { ...config, additionalModels: [NotInProject as ModelConstructor] },
        }),
      ).rejects.toThrow(/NotInProject/);
    });

    it('force-includes an interface via the `path#Name` string form', async () => {
      // The base fixture config pins `MaintenanceWindow` — an orphan interface.
      const document = await buildFixtureDocument();
      expect(document.components?.schemas).toHaveProperty('MaintenanceWindow');
    });

    it('resolves the bare-name string form too', async () => {
      const document = await buildFixtureDocument({ additionalModels: ['MaintenanceWindow'] });
      expect(document.components?.schemas).toHaveProperty('MaintenanceWindow');
    });

    it('throws when the file in a `path#Name` entry has no such model', async () => {
      await expect(
        buildFixtureDocument({ additionalModels: ['src/health/system-status.ts#Nope'] }),
      ).rejects.toThrow(/Nope/);
    });

    it('throws when the file in a `path#Name` entry is not in the project', async () => {
      await expect(
        buildFixtureDocument({ additionalModels: ['src/does/not/exist.ts#Region'] }),
      ).rejects.toThrow(/exist\.ts/);
    });
  });

  describe('interface & type models', () => {
    it('emits an interface return type as a `$ref` + component', async () => {
      const document = await buildFixtureDocument();
      const status = document.paths['/api/health/status'].get as {
        responses: Record<
          string,
          { content: { 'application/json': { schema: Record<string, unknown> } } }
        >;
      };
      const schema = status.responses['200'].content['application/json'].schema as {
        properties: Record<string, { $ref?: string }>;
      };
      expect(schema.properties.data.$ref).toBe('#/components/schemas/SystemStatus');
      expect(document.components?.schemas).toHaveProperty('SystemStatus');
    });

    it('folds `extends` heritage into the interface schema', async () => {
      const document = await buildFixtureDocument();
      const status = document.components?.schemas?.SystemStatus as {
        properties: Record<string, unknown>;
        required: string[];
      };
      // `uptimeSeconds` comes from the base interface `BaseStatus`.
      expect(status.properties).toHaveProperty('uptimeSeconds');
      expect(status.required).toContain('uptimeSeconds');
    });

    it('emits a string-literal-union `type` alias inline as an enum', async () => {
      const document = await buildFixtureDocument();
      const status = document.components?.schemas?.SystemStatus as {
        properties: Record<string, { type?: string; enum?: string[] }>;
      };
      expect(status.properties.region).toEqual({
        type: 'string',
        enum: ['us-east', 'eu-west', 'asia'],
      });
    });

    it('emits an object `type` alias as a component, refing nested models', async () => {
      const document = await buildFixtureDocument();
      const summary = document.components?.schemas?.StatusSummary as {
        properties: Record<string, { $ref?: string; type?: string }>;
        required: string[];
      };
      expect(summary.properties.status.$ref).toBe('#/components/schemas/SystemStatus');
      // optional `note?` is absent from `required`.
      expect(summary.required).not.toContain('note');
    });

    it('expands an anonymous inline object instead of degrading to {type:object}', async () => {
      const document = await buildFixtureDocument();
      const meta = (
        document.components?.schemas?.StatusSummary as {
          properties: Record<string, { properties?: Record<string, unknown> }>;
        }
      ).properties.meta;
      expect(meta.properties).toHaveProperty('degraded');
    });
  });
});

describe('recursive types do not overflow the stack', () => {
  // A recursive *anonymous* object (here `Pick<Category, ...>`, whose alias
  // `Pick` is a lib type outside the source tree, so it has no name to `$ref`)
  // used to expand forever — "Maximum call stack size exceeded". The cycle guard
  // in `schemaForType` must break it, degrading the repeated node to {type:object}.
  async function buildRecursiveDoc(propType: string): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-recursive-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'commonjs',
            experimentalDecorators: true,
            strict: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'tree.controller.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          '',
          'export interface Category {',
          '  name: string;',
          `  children: ${propType};`,
          '}',
          '',
          "@Controller('cat')",
          'export class TreeController {',
          '  @Get()',
          '  root(): Category {',
          "    return { name: 'root', children: [] };",
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Tree', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('terminates on a recursive anonymous object and degrades the cycle', async () => {
    const doc = await buildRecursiveDoc("Pick<Category, 'name' | 'children'>[]");
    const category = doc.components?.schemas?.Category as {
      properties: { children: { items: { properties: { children: { items: unknown } } } } };
    };
    // First level expands; the recursive re-entry bottoms out at {type:object}.
    const grandchildItems = category.properties.children.items.properties.children.items;
    expect(grandchildItems).toEqual({ type: 'object' });
  });

  it('still `$ref`s a *named* recursive type instead of inlining it', async () => {
    // A named self-referential interface is broken by `$ref`, not the depth guard.
    const doc = await buildRecursiveDoc('Category[]');
    const category = doc.components?.schemas?.Category as {
      properties: { children: { items: { $ref?: string } } };
    };
    expect(category.properties.children.items.$ref).toBe('#/components/schemas/Category');
  });
});

describe('intersection `type` aliases', () => {
  // `type T = Omit<X, K> & { ... }` is neither a union nor `isObject()`, but its
  // merged members are reachable via getProperties(). It must expand to a real
  // object — not fall through to a degenerate `{ $ref: <self> }`, which makes
  // deref-based renderers (Scalar) recurse forever ("too much recursion").
  async function buildIntersectionDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-intersection-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'commonjs',
            experimentalDecorators: true,
            strict: true,
          },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'entity.controller.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          '',
          'export class Entity {',
          '  id!: string;',
          '  secret!: string;',
          '  name!: string;',
          '}',
          '',
          "export type PublicEntity = Omit<Entity, 'secret'> & { extra: string };",
          '',
          "@Controller('e')",
          'export class EntityController {',
          '  @Get()',
          '  one(): PublicEntity {',
          "    return { id: '1', name: 'n', extra: 'x' };",
          '  }',
          '}',
          '',
        ].join('\n'),
      );
      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'E', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('expands `Omit<X, K> & { ... }` to a merged object, never a self-$ref', async () => {
    const doc = await buildIntersectionDoc();
    const schema = doc.components?.schemas?.PublicEntity as {
      $ref?: string;
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.$ref).toBeUndefined();
    expect(schema.type).toBe('object');
    // `Omit` members survive minus the omitted key; the `& { ... }` member folds in.
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['extra', 'id', 'name']);
    expect(schema.properties).not.toHaveProperty('secret');
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
      '/api/health/status',
      '/api/health/summary',
      '/api/posts',
      '/api/users',
      '/api/users/{id}',
    ]);
    // The `pages` doc tag is prepended ahead of the controller tags.
    expect(document.tags?.map((t) => t.name)).toEqual([
      'Getting Started',
      'Auth',
      'System Health',
      'Posts',
      'Users',
    ]);
    expect(Object.keys(document.components?.schemas ?? {})).toEqual([
      // `additionalModels` entries are registered before the path walk.
      'MaintenanceWindow',
      'LoginDto',
      'LoginResponseDto',
      'HealthStatusDto',
      'SystemStatus',
      'StatusSummary',
      'CreatePostDto',
      'BlogPost',
      'User',
      'CreateUserDto',
      'UpdateUserDto',
      // Registered transitively while `SystemStatus` is built, so it lands last.
      'ServiceHealth',
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
  async function buildCatsDoc(): Promise<OpenApiDocument> {
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

  it('synthesizes a string path param when the route declares one but no @Param binds it', async () => {
    const doc = await buildCatsDoc();
    expect(paramsOf(doc, '/cats/{id}')).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('emits every placeholder, in template order, for multi-param routes', async () => {
    const doc = await buildCatsDoc();
    expect(paramsOf(doc, '/cats/{from}/{to}')).toEqual([
      { name: 'from', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'to', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('uses the explicit @Param schema when its name matches the template', async () => {
    const doc = await buildCatsDoc();
    expect(paramsOf(doc, '/cats/named/{slug}')).toEqual([
      { name: 'slug', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('ignores a @Param whose name is absent from the template, still emitting the placeholder', async () => {
    const doc = await buildCatsDoc();
    const params = paramsOf(doc, '/cats/{id}/detail');
    expect(params.map((p) => p.name)).toEqual(['id']);
    expect(params[0].schema).toEqual({ type: 'string' });
  });
});

describe('enum schemas', () => {
  // Derive every property schema of `Holder`, whose fields are typed by enums
  // of each value kind. The fixture only has string enums, so use a throwaway.
  function holderProps(): Record<string, Record<string, unknown>> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-enum-')));
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
          'export enum Explicit { A = 1, B = 2 }',
          'export enum Implicit { X, Y, Z }',
          "export enum Strings { DRAFT = 'DRAFT', PUBLISHED = 'PUBLISHED' }",
          'export enum Floats { LOW = 0.5, HIGH = 1.5 }',
          'export class Holder {',
          '  explicit!: Explicit;',
          '  implicit!: Implicit;',
          '  strings!: Strings;',
          '  floats!: Floats;',
          '}',
          '',
        ].join('\n'),
      );
      const index = new AstIndex({
        projectRoot: tmp,
        project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
      });
      const holder = index.getClass('Holder');
      expect(holder).toBeDefined();
      return new SchemaBuilder(index).buildMembers(holder!).properties as Record<
        string,
        Record<string, unknown>
      >;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('emits integer for an explicitly-numbered numeric enum', () => {
    expect(holderProps().explicit).toEqual({ type: 'integer', enum: [1, 2] });
  });

  it('emits integer for an implicit (auto-numbered) numeric enum', () => {
    expect(holderProps().implicit).toEqual({ type: 'integer', enum: [0, 1, 2] });
  });

  it('keeps string for a string enum', () => {
    expect(holderProps().strings).toEqual({ type: 'string', enum: ['DRAFT', 'PUBLISHED'] });
  });

  it('emits number (not integer) for a non-integer numeric enum', () => {
    expect(holderProps().floats).toEqual({ type: 'number', enum: [0.5, 1.5] });
  });
});

describe('response status (@HttpCode)', () => {
  const statusOf = (doc: OpenApiDocument, path: string, method: 'get' | 'post' | 'delete') =>
    Object.keys((doc.paths[path]?.[method] as { responses: Record<string, unknown> }).responses)[0];

  async function buildThingsDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-httpcode-')));
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
        path.join(tmp, 'src', 'things.controller.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Post(path?: string): MethodDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          'declare function Delete(path?: string): MethodDecorator;',
          'declare function HttpCode(code: number): MethodDecorator;',
          'declare const HttpStatus: { OK: number; ACCEPTED: number; NO_CONTENT: number };',
          '',
          "@Controller('things')",
          'export class ThingsController {',
          "  @Post('default')",
          '  createDefault(): void {}',
          '',
          "  @Post('no-content')",
          '  @HttpCode(204)',
          '  noContent(): void {}',
          '',
          "  @Post('accepted')",
          '  @HttpCode(HttpStatus.ACCEPTED)',
          '  accepted(): void {}',
          '',
          "  @Get('ok')",
          '  ok(): void {}',
          '',
          "  @Delete('gone')",
          '  @HttpCode(HttpStatus.NO_CONTENT)',
          '  gone(): void {}',
          '}',
          '',
        ].join('\n'),
      );

      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Things', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('defaults to 201 for POST and 200 for other verbs when no @HttpCode', async () => {
    const doc = await buildThingsDoc();
    expect(statusOf(doc, '/things/default', 'post')).toBe('201');
    expect(statusOf(doc, '/things/ok', 'get')).toBe('200');
  });

  it('honors a numeric @HttpCode literal', async () => {
    expect(statusOf(await buildThingsDoc(), '/things/no-content', 'post')).toBe('204');
  });

  it('resolves an @HttpCode(HttpStatus.MEMBER) reference', async () => {
    const doc = await buildThingsDoc();
    expect(statusOf(doc, '/things/accepted', 'post')).toBe('202');
    expect(statusOf(doc, '/things/gone', 'delete')).toBe('204');
  });
});

describe('array route paths', () => {
  type Op = { operationId: string; parameters?: { name: string; in: string }[] };
  const getOp = (doc: OpenApiDocument, path: string): Op | undefined =>
    doc.paths[path]?.get as Op | undefined;

  async function buildDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-arraypath-')));
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
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string | string[]): ClassDecorator;',
          'declare function Get(path?: string | string[]): MethodDecorator;',
          'declare function Param(name: string): ParameterDecorator;',
          '',
          "@Controller('cats')",
          'export class CatsController {',
          "  @Get(['a', 'b'])",
          '  ab(): void {}',
          '',
          "  @Get([':id', 'all'])",
          "  byIdOrAll(@Param('id') _id: string): void {}",
          '',
          "  @Get(['dup', 'dup'])",
          '  dup(): void {}',
          '}',
          '',
          "@Controller(['v1/admin', 'v2/admin'])",
          'export class AdminController {',
          "  @Get('ping')",
          '  ping(): void {}',
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

  it('emits one operation per entry in an array route, with unique operationIds', async () => {
    const doc = await buildDoc();
    const a = getOp(doc, '/cats/a');
    const b = getOp(doc, '/cats/b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.operationId).not.toBe(b!.operationId);
  });

  it('computes path params per path — a placeholder entry vs a static alias', async () => {
    const doc = await buildDoc();
    const byId = getOp(doc, '/cats/{id}');
    const all = getOp(doc, '/cats/all');
    expect(byId?.parameters?.map((p) => p.name)).toEqual(['id']);
    // The static alias shares the @Param('id') binding but has no {id} placeholder.
    expect(all?.parameters ?? []).toEqual([]);
  });

  it('expands an array @Controller prefix across every route', async () => {
    const doc = await buildDoc();
    expect(getOp(doc, '/v1/admin/ping')).toBeDefined();
    expect(getOp(doc, '/v2/admin/ping')).toBeDefined();
  });

  it('collapses duplicate entries in an array path', async () => {
    const doc = await buildDoc();
    expect(getOp(doc, '/cats/dup')).toBeDefined();
    // No spurious `_2` operation was created for the duplicate.
    expect(getOp(doc, '/cats/dup')!.operationId).toBe('Cats_dup');
  });
});

describe('method-level @Tag declaration', () => {
  const opTags = (doc: OpenApiDocument, path: string): string[] =>
    (doc.paths[path]?.get as { tags: string[] }).tags;

  async function buildDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-tag-')));
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
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          '',
          '/**',
          ' * Catalog operations.',
          ' *',
          ' * @Tag Catalog',
          ' */',
          "@Controller('catalog')",
          'export class CatalogController {',
          "  @Get('list')",
          '  list(): void {}',
          '',
          '  /** @Tag Diagnostics */',
          "  @Get('ping')",
          '  ping(): void {}',
          '',
          '  /** @Tag Reports */',
          "  @Get('export')",
          '  exportData(): void {}',
          '}',
          '',
          '/**',
          ' * Reporting operations.',
          ' *',
          ' * @Tag Reports',
          ' */',
          "@Controller('reports')",
          'export class ReportsController {',
          "  @Get('summary')",
          '  summary(): void {}',
          '}',
          '',
        ].join('\n'),
      );

      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Catalog', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('routes operations to their method-level tag', async () => {
    const doc = await buildDoc();
    expect(opTags(doc, '/catalog/list')).toEqual(['Catalog']);
    expect(opTags(doc, '/catalog/ping')).toEqual(['Diagnostics']);
    expect(opTags(doc, '/catalog/export')).toEqual(['Reports']);
  });

  it('declares a novel method tag in root tags[], after controller tags, with no description', async () => {
    const doc = await buildDoc();
    expect(doc.tags?.map((t) => t.name)).toEqual(['Catalog', 'Reports', 'Diagnostics']);
    expect(doc.tags?.find((t) => t.name === 'Diagnostics')).toEqual({ name: 'Diagnostics' });
  });

  it("a controller's description wins over a same-named method-tag placeholder", async () => {
    const doc = await buildDoc();
    // `@Tag Reports` appears on a CatalogController method AND as ReportsController's
    // tag — the controller's description must survive.
    expect(doc.tags?.find((t) => t.name === 'Reports')?.description).toBe('Reporting operations.');
    expect(doc.tags?.find((t) => t.name === 'Catalog')?.description).toBe('Catalog operations.');
  });

  it("does not emit a controller's derived tag when every operation overrides it", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-emptytag-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true },
          include: ['src/**/*.ts'],
        }),
      );
      // RootController's only endpoint carries its own `@Tag Health`, so the
      // derived `Root` tag is never used and must not leak into root tags[].
      fs.writeFileSync(
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          "@Controller('/')",
          'export class RootController {',
          '  /** @Tag Health */',
          "  @Get('health')",
          '  health(): void {}',
          '}',
          '',
        ].join('\n'),
      );

      const doc = await parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Root', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });

      expect(doc.tags?.map((t) => t.name)).toEqual(['Health']);
      expect(opTags(doc, '/health')).toEqual(['Health']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('optional & unsupported route patterns', () => {
  type Op = { operationId: string; parameters?: { name: string; in: string }[] };
  const getOp = (doc: OpenApiDocument, p: string): Op | undefined =>
    doc.paths[p]?.get as Op | undefined;

  async function build(): Promise<{ doc: OpenApiDocument; warnings: string[] }> {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((msg?: unknown) => {
      warnings.push(String(msg));
    });
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-routepat-')));
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
        path.join(tmp, 'src', 'users.controller.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          'declare function Param(name: string): ParameterDecorator;',
          '',
          "@Controller('users')",
          'export class UsersController {',
          "  @Get(':id?')", // optional trailing → /users and /users/{id}
          "  findOne(@Param('id') _id: string): void {}",
          '',
          "  @Get('a/:x?/b')", // optional in the middle → /users/a/b and /users/a/{x}/b
          '  mid(): void {}',
          '',
          "  @Get('num/:id([0-9]+)')", // regex → skipped
          '  numeric(): void {}',
          '',
          "  @Get('files/*')", // wildcard → skipped
          '  wild(): void {}',
          '',
          "  @Get(':a?/:b?')", // two optionals → skipped
          '  twoOpt(): void {}',
          '',
          "  @Get('ok')", // plain → /users/ok
          '  ok(): void {}',
          '}',
          '',
        ].join('\n'),
      );

      const doc = await parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Users', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
      return { doc, warnings };
    } finally {
      spy.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('splits a trailing optional param into a with/without pair', async () => {
    const { doc } = await build();
    expect(getOp(doc, '/users')).toBeDefined();
    expect(getOp(doc, '/users/{id}')).toBeDefined();
    expect(getOp(doc, '/users')!.parameters ?? []).toEqual([]);
    expect(getOp(doc, '/users/{id}')!.parameters?.map((p) => p.name)).toEqual(['id']);
    // The two halves are distinct operations.
    expect(getOp(doc, '/users')!.operationId).not.toBe(getOp(doc, '/users/{id}')!.operationId);
  });

  it('splits an optional param in the middle of the route', async () => {
    const { doc } = await build();
    expect(getOp(doc, '/users/a/b')).toBeDefined();
    expect(getOp(doc, '/users/a/{x}/b')).toBeDefined();
  });

  it('skips regex, wildcard, and multi-optional routes, keeping plain ones', async () => {
    const { doc } = await build();
    expect(getOp(doc, '/users/num/{id}')).toBeUndefined();
    expect(Object.keys(doc.paths).some((p) => p.includes('files'))).toBe(false);
    expect(getOp(doc, '/users/{a}')).toBeUndefined();
    expect(getOp(doc, '/users/{a}/{b}')).toBeUndefined();
    // A normal sibling route is still emitted.
    expect(getOp(doc, '/users/ok')).toBeDefined();
  });

  it('logs a warning naming each skipped route', async () => {
    const { warnings } = await build();
    expect(warnings.some((w) => w.includes('num/:id') && /unsupported/.test(w))).toBe(true);
    expect(warnings.some((w) => w.includes('files/*') && /unsupported/.test(w))).toBe(true);
    expect(warnings.some((w) => w.includes(':a?/:b?') && /optional/.test(w))).toBe(true);
  });
});

describe('property descriptions on $ref schemas', () => {
  // A `$ref` is a Reference Object whose siblings are ignored in OpenAPI 3.0, so a
  // described class-typed property must be wrapped in `allOf` for the description
  // to survive. Undescribed refs stay bare; primitives take the description inline.
  function holderProps(): Record<string, Record<string, unknown>> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-refdesc-')));
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
          'export class Inner {',
          '  x!: string;',
          '}',
          'export class Outer {',
          '  /** Described overlay. */',
          '  described!: Inner;',
          '  plain!: Inner;',
          '  /** An email. */',
          '  email!: string;',
          '}',
          '',
        ].join('\n'),
      );
      const index = new AstIndex({
        projectRoot: tmp,
        project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
      });
      const outer = index.getClass('Outer');
      expect(outer).toBeDefined();
      return new SchemaBuilder(index).buildMembers(outer!).properties as Record<
        string,
        Record<string, unknown>
      >;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('wraps a described class-typed property in allOf so the description survives', () => {
    expect(holderProps().described).toEqual({
      allOf: [{ $ref: '#/components/schemas/Inner' }],
      description: 'Described overlay.',
    });
  });

  it('leaves an undescribed class-typed property as a bare $ref', () => {
    expect(holderProps().plain).toEqual({ $ref: '#/components/schemas/Inner' });
  });

  it('keeps a described primitive property inline (description as a normal sibling)', () => {
    expect(holderProps().email).toEqual({ type: 'string', description: 'An email.' });
  });
});

describe('class-validator constraint mapping', () => {
  function props(): Record<string, Record<string, unknown>> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-validator-')));
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
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Min(n: number): PropertyDecorator;',
          'declare function Max(n: number): PropertyDecorator;',
          'declare function MinLength(n: number): PropertyDecorator;',
          'declare function MaxLength(n: number): PropertyDecorator;',
          'declare function Length(a: number, b: number): PropertyDecorator;',
          'declare function IsInt(): PropertyDecorator;',
          'declare function IsEmail(): PropertyDecorator;',
          'declare function IsUrl(): PropertyDecorator;',
          'declare function IsUUID(): PropertyDecorator;',
          'declare function IsDateString(): PropertyDecorator;',
          'declare function Matches(re: RegExp): PropertyDecorator;',
          'declare function IsPositive(): PropertyDecorator;',
          'declare function IsNegative(): PropertyDecorator;',
          'declare function ArrayMinSize(n: number): PropertyDecorator;',
          'declare function ArrayMaxSize(n: number): PropertyDecorator;',
          '',
          'export class V {',
          '  @Min(1) @Max(100) @IsInt() count!: number;',
          '  @MinLength(2) @MaxLength(8) name!: string;',
          '  @Length(3, 5) code!: string;',
          '  @IsEmail() email!: string;',
          '  @IsUrl() website!: string;',
          '  @IsUUID() id!: string;',
          '  @IsDateString() when!: string;',
          '  @Matches(/^\\d{3}$/) zip!: string;',
          '  @IsPositive() pos!: number;',
          '  @IsNegative() neg!: number;',
          '  @Min(-5) floor!: number;',
          '  @ArrayMinSize(1) @ArrayMaxSize(3) tags!: string[];',
          '}',
          '',
        ].join('\n'),
      );
      const index = new AstIndex({
        projectRoot: tmp,
        project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
      });
      const v = index.getClass('V');
      expect(v).toBeDefined();
      return new SchemaBuilder(index).buildMembers(v!).properties as Record<
        string,
        Record<string, unknown>
      >;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('maps numeric, length, format, pattern and array constraints', () => {
    const p = props();
    expect(p.count).toEqual({ type: 'integer', minimum: 1, maximum: 100 });
    expect(p.name).toEqual({ type: 'string', minLength: 2, maxLength: 8 });
    expect(p.code).toEqual({ type: 'string', minLength: 3, maxLength: 5 });
    expect(p.email).toEqual({ type: 'string', format: 'email' });
    expect(p.website).toEqual({ type: 'string', format: 'uri' });
    expect(p.id).toEqual({ type: 'string', format: 'uuid' });
    expect(p.when).toEqual({ type: 'string', format: 'date-time' });
    expect(p.zip).toEqual({ type: 'string', pattern: '^\\d{3}$' });
    expect(p.tags).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 3,
    });
  });

  it('maps @IsPositive/@IsNegative to exclusive bounds and handles negative literals', () => {
    const p = props();
    expect(p.pos).toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true });
    expect(p.neg).toEqual({ type: 'number', maximum: 0, exclusiveMaximum: true });
    expect(p.floor).toEqual({ type: 'number', minimum: -5 });
  });
});

describe('config title/version defaults', () => {
  function writeProject(openapi: unknown, pkg?: object): string {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-cfg-')));
    fs.writeFileSync(path.join(tmp, 'nestparser.config.json'), JSON.stringify({ openapi }));
    if (pkg) fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
    return tmp;
  }

  it('fills a missing title/version from package.json (config values win when present)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // title omitted → from package.json name; version present in config → kept.
    const tmp = writeProject({ version: '9.9.9' }, { name: 'svc', version: '2.0.0' });
    try {
      const { config } = await loadConfig({ projectRoot: tmp });
      expect(config.openapi).toEqual({ title: 'svc', version: '9.9.9' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/missing openapi\.title/));
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to generic title/version when neither config nor package.json provides them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmp = writeProject({ description: 'no title or version here' });
    try {
      const { config } = await loadConfig({ projectRoot: tmp });
      expect(config.openapi.title).toBe('API');
      expect(config.openapi.version).toBe('1.0.0');
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('leaves a complete config untouched and does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmp = writeProject({ title: 'X', version: '1.0.0' });
    try {
      const { config } = await loadConfig({ projectRoot: tmp });
      expect(config.openapi).toEqual({ title: 'X', version: '1.0.0' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("still rejects a config that has no 'openapi' object", async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-cfg-')));
    fs.writeFileSync(path.join(tmp, 'nestparser.config.json'), JSON.stringify({ project: {} }));
    try {
      await expect(loadConfig({ projectRoot: tmp })).rejects.toThrow(/missing 'openapi'/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('config fallback (no config file)', () => {
  function tmpProject(pkg?: object): string {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-nocfg-')));
    if (pkg) fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
    return tmp;
  }

  it('falls back to a default config from package.json and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmp = tmpProject({ name: 'my-svc', version: '2.3.4' });
    try {
      const { config, filePath } = await loadConfig({ projectRoot: tmp });
      expect(filePath).toBeUndefined();
      expect(config.openapi).toEqual({ title: 'my-svc', version: '2.3.4' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/No config file found/));
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses generic title/version when package.json is absent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tmp = tmpProject();
    try {
      const { config } = await loadConfig({ projectRoot: tmp });
      expect(config.openapi).toEqual({ title: 'API', version: '1.0.0' });
    } finally {
      warn.mockRestore();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still throws when an explicit --config path does not exist', async () => {
    const tmp = tmpProject();
    try {
      await expect(loadConfig({ projectRoot: tmp, configPath: 'nope.config.ts' })).rejects.toThrow(
        /not found/i,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('endpoint summary', () => {
  async function summaries(hooks?: NestParserConfig['hooks']): Promise<Record<string, string>> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-summary-')));
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
        path.join(tmp, 'src', 'items.controller.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          '',
          "@Controller('items')",
          'export class ItemsController {',
          '  @Get()',
          '  findOne(): void {}',
          '',
          '  /** @Name Custom label */',
          "  @Get('named')",
          '  getNamed(): void {}',
          '}',
          '',
        ].join('\n'),
      );
      const doc = await parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'I', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
          hooks,
        },
      });
      const result: Record<string, string> = {};
      for (const [p, ops] of Object.entries(doc.paths)) {
        const op = ops.get as { summary?: string } | undefined;
        if (op?.summary) result[p] = op.summary;
      }
      return result;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('defaults to the humanized method name', async () => {
    expect((await summaries())['/items']).toBe('Find One');
  });

  it('a method-level @Name overrides the default', async () => {
    expect((await summaries())['/items/named']).toBe('Custom label');
  });

  it('the endpointSummary hook overrides the default but not @Name', async () => {
    const s = await summaries({
      endpointSummary: ({ httpMethod, defaultSummary }) =>
        `${httpMethod.toUpperCase()} ${defaultSummary}`,
    });
    expect(s['/items']).toBe('GET Find One');
    expect(s['/items/named']).toBe('Custom label');
  });

  it('falls back to the default when the hook returns null', async () => {
    expect((await summaries({ endpointSummary: () => null }))['/items']).toBe('Find One');
  });
});

describe('@Accept / @ContentType media types', () => {
  async function buildDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-media-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Post(path?: string): MethodDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          'declare function Body(): ParameterDecorator;',
          '',
          'export class UploadDto { file!: string; }',
          'export class Item { id!: string; }',
          '',
          "@Controller('items')",
          'export class ItemsController {',
          '  /**',
          '   * @Accept multipart/form-data',
          '   * @ContentType application/xml',
          '   */',
          "  @Post('upload')",
          '  upload(@Body() _dto: UploadDto): Item {',
          '    return new Item();',
          '  }',
          '',
          "  @Post('create')",
          '  create(@Body() _dto: UploadDto): Item {',
          '    return new Item();',
          '  }',
          '}',
          '',
        ].join('\n'),
      );

      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Items', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  type Op = {
    requestBody?: { content: Record<string, unknown> };
    responses: Record<string, { content?: Record<string, unknown> }>;
  };
  const op = (doc: OpenApiDocument, p: string): Op => doc.paths[p]?.post as Op;

  it('@Accept overrides the request body media type', async () => {
    const upload = op(await buildDoc(), '/items/upload');
    expect(Object.keys(upload.requestBody!.content)).toEqual(['multipart/form-data']);
  });

  it('@ContentType overrides the response media type', async () => {
    const upload = op(await buildDoc(), '/items/upload');
    expect(Object.keys(upload.responses['201'].content!)).toEqual(['application/xml']);
  });

  it('defaults both to application/json when the tags are absent', async () => {
    const create = op(await buildDoc(), '/items/create');
    expect(Object.keys(create.requestBody!.content)).toEqual(['application/json']);
    expect(Object.keys(create.responses['201'].content!)).toEqual(['application/json']);
  });
});

describe('file uploads (@UploadedFile / interceptors)', () => {
  async function buildDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-upload-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Post(path?: string): MethodDecorator;',
          'declare function Body(): ParameterDecorator;',
          'declare function UploadedFile(...a: unknown[]): ParameterDecorator;',
          'declare function UploadedFiles(...a: unknown[]): ParameterDecorator;',
          'declare function UseInterceptors(...a: unknown[]): MethodDecorator;',
          'declare function FileInterceptor(field: string): unknown;',
          'declare function FilesInterceptor(field: string): unknown;',
          '',
          'export class UploadDto { note!: string; }',
          '',
          "@Controller('files')",
          'export class FilesController {',
          "  @Post('one')",
          "  @UseInterceptors(FileInterceptor('logFile'))",
          '  one(@Body() _dto: UploadDto, @UploadedFile() _f: unknown): void {}',
          '',
          "  @Post('many')",
          "  @UseInterceptors(FilesInterceptor('photos'))",
          '  many(@UploadedFiles() _f: unknown): void {}',
          '}',
          '',
        ].join('\n'),
      );

      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Files', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  type Body = { content: Record<string, { schema: Record<string, unknown> }> };
  const body = (doc: OpenApiDocument, p: string): Body =>
    (doc.paths[p]?.post as { requestBody: Body }).requestBody;

  it('emits a binary file field merged with @Body fields under multipart/form-data', async () => {
    const b = body(await buildDoc(), '/files/one');
    expect(Object.keys(b.content)).toEqual(['multipart/form-data']);
    const schema = b.content['multipart/form-data'].schema;
    expect(schema.properties).toEqual({
      note: { type: 'string' },
      logFile: { type: 'string', format: 'binary' },
    });
    expect(schema.required).toEqual(['note', 'logFile']);
  });

  it('represents FilesInterceptor / @UploadedFiles as an array of binary', async () => {
    const b = body(await buildDoc(), '/files/many');
    const schema = b.content['multipart/form-data'].schema;
    expect(schema.properties).toEqual({
      photos: { type: 'array', items: { type: 'string', format: 'binary' } },
    });
  });
});

describe('pages (x-tagGroups Markdown pages)', () => {
  async function buildDoc(pages?: PagesConfig): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-pages-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.mkdirSync(path.join(tmp, 'docs'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          "@Controller('items')",
          'export class ItemsController {',
          '  @Get()',
          '  list(): void {}',
          '}',
          '',
        ].join('\n'),
      );
      fs.writeFileSync(path.join(tmp, 'docs', 'intro.md'), '# Getting Started\n\nWelcome.\n');
      fs.writeFileSync(path.join(tmp, 'docs', 'no-title.md'), 'Just text, no heading.\n');

      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: { title: 'Items', version: '1.0.0' },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
          pages,
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('titles a page from its first `#` heading, else the file name', async () => {
    const doc = await buildDoc({ files: ['docs/intro.md', 'docs/no-title.md'] });
    // Heading line is dropped (it becomes the title) and the body is trimStarted.
    expect(doc.tags?.find((t) => t.name === 'Getting Started')?.description).toBe('Welcome.\n');
    // No heading → file base name (extension stripped); body kept whole.
    expect(doc.tags?.find((t) => t.name === 'no-title')?.description).toBe(
      'Just text, no heading.\n',
    );
  });

  it('prepends page tags but emits no x-tagGroups when neither group name is set', async () => {
    const doc = await buildDoc({ files: ['docs/intro.md', 'docs/no-title.md'] });
    expect(doc.tags?.map((t) => t.name)).toEqual(['Getting Started', 'no-title', 'Items']);
    expect(doc['x-tagGroups']).toBeUndefined();
  });

  it('enables x-tagGroups when a section name is given, defaulting the other', async () => {
    const doc = await buildDoc({ files: ['docs/intro.md', 'docs/no-title.md'], group: 'Guides' });
    expect(doc['x-tagGroups']).toEqual([
      { name: 'Guides', tags: ['Getting Started', 'no-title'] },
      { name: 'API', tags: ['Items'] }, // apiGroup falls back to its default
    ]);
  });

  it('honors custom group / apiGroup names', async () => {
    const doc = await buildDoc({
      files: ['docs/intro.md'],
      group: 'Guides',
      apiGroup: 'Endpoints',
    });
    expect(doc['x-tagGroups']).toEqual([
      { name: 'Guides', tags: ['Getting Started'] },
      { name: 'Endpoints', tags: ['Items'] },
    ]);
  });

  it('emits no x-tagGroups when pages is absent', async () => {
    const doc = await buildDoc();
    expect(doc['x-tagGroups']).toBeUndefined();
    expect(doc.tags?.map((t) => t.name)).toEqual(['Items']);
  });

  it('throws when a page file is missing', async () => {
    await expect(buildDoc({ files: ['docs/missing.md'] })).rejects.toThrow(
      /Markdown file not found/,
    );
  });
});

describe('securitySchemes with null/undefined entries', () => {
  async function buildDoc(): Promise<OpenApiDocument> {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-secsch-')));
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(
        path.join(tmp, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'commonjs', experimentalDecorators: true },
          include: ['src/**/*.ts'],
        }),
      );
      fs.writeFileSync(
        path.join(tmp, 'src', 'models.ts'),
        [
          'declare function Controller(prefix?: string): ClassDecorator;',
          'declare function Get(path?: string): MethodDecorator;',
          "@Controller('items')",
          'export class ItemsController {',
          '  @Get()',
          '  list(): void {}',
          '}',
          '',
        ].join('\n'),
      );

      // No resolveSecurity hook → the default policy applies every *registered*
      // scheme, so a dropped scheme must not appear in the operation's security.
      return parseNestProject({
        projectRoot: tmp,
        config: {
          openapi: {
            title: 'Items',
            version: '1.0.0',
            securitySchemes: {
              bearerAuth: { type: 'http', scheme: 'bearer' },
              apiKey: undefined,
              legacy: null,
            },
          },
          project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
        },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  it('omits nullish schemes from components.securitySchemes', async () => {
    const doc = await buildDoc();
    expect(doc.components?.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer' },
    });
  });

  it('does not apply a dropped scheme in the default security policy', async () => {
    const doc = await buildDoc();
    expect((doc.paths['/items'].get as { security: unknown }).security).toEqual([
      { bearerAuth: [] },
    ]);
  });
});
