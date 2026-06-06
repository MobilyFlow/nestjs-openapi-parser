import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getScopes, getTags, loadConfig, parseNestProject, parseScopeList } from '../src/lib';
import type { ModelConstructor, NestParserConfig } from '../src/lib';
import { AstIndex } from '../src/parser/ast-index';
import type { OpenApiDocument } from '../src/types/openapi';

const FIXTURE = path.resolve(__dirname, 'fixtures/example-app');

async function build(overrides: Partial<NestParserConfig> = {}): Promise<OpenApiDocument> {
  const { config } = await loadConfig({ projectRoot: FIXTURE });
  return parseNestProject({ projectRoot: FIXTURE, config: { ...config, ...overrides } });
}

// Stub class references — only `.name` matters; the parser resolves the
// fixture's class by that name.
class AdminMeta {}

describe('scope filtering', () => {
  describe('untagged-only default (no scopes)', () => {
    it('omits scoped controllers, methods, properties and types', async () => {
      const doc = await build();
      expect(doc.paths['/api/admin/whoami']).toBeUndefined();
      expect(doc.paths['/api/users/{id}/bridge']).toBeUndefined();
      expect(doc.components?.schemas).not.toHaveProperty('AdminMeta');
      const user = doc.components?.schemas?.User as { properties: Record<string, unknown> };
      expect(user.properties).not.toHaveProperty('lastLoginIp');
      expect(user.properties).not.toHaveProperty('adminMeta');
    });
  });

  describe("scopes: ['admin']", () => {
    it('emits admin items including the AdminController and AdminMeta schema', async () => {
      const doc = await build({ scopes: ['admin'] });
      expect(doc.paths['/api/admin/whoami']).toBeDefined();
      const user = doc.components?.schemas?.User as { properties: Record<string, unknown> };
      expect(user.properties).not.toHaveProperty('lastLoginIp');
      expect(user.properties).toHaveProperty('adminMeta');

      const adminMeta = doc.components?.schemas?.AdminMeta as {
        properties: Record<string, unknown>;
      };
      expect(adminMeta).toBeDefined();
      // Property-level @Scope admin emitted; untagged ones too.
      expect(adminMeta.properties).toHaveProperty('internalKey');
      expect(adminMeta.properties).toHaveProperty('note');
      expect(adminMeta.properties).toHaveProperty('publicKey');
    });
  });

  describe("scopes: ['internal', 'admin']", () => {
    it('emits the union of all scoped items', async () => {
      const doc = await build({ scopes: ['internal', 'admin'] });
      const user = doc.components?.schemas?.User as { properties: Record<string, unknown> };
      expect(user.properties).toHaveProperty('lastLoginIp');
      expect(user.properties).toHaveProperty('adminMeta');
      expect(doc.paths['/api/admin/whoami']).toBeDefined();
      expect(doc.paths['/api/users/{id}/bridge']).toBeDefined();
    });
  });

  describe('consistency check', () => {
    it("throws when a visible method's return type is invisible (bridgeAction → AdminMeta)", async () => {
      // bridgeAction is @Scope internal → visible under ['internal'].
      // Its return type AdminMeta is @Scope admin → invisible.
      await expect(build({ scopes: ['internal'] })).rejects.toThrow(/AdminMeta/);
    });

    it('throws when additionalModels references an invisibly-scoped class', async () => {
      await expect(
        build({ scopes: ['internal'], additionalModels: [AdminMeta as ModelConstructor] }),
      ).rejects.toThrow(/AdminMeta/);
    });

    it('additionalModels succeeds when a matching scope is active', async () => {
      const doc = await build({
        scopes: ['admin'],
        additionalModels: [AdminMeta as ModelConstructor],
      });
      expect(doc.components?.schemas).toHaveProperty('AdminMeta');
    });
  });
});

describe('tag parsing helpers', () => {
  it('parses comma-separated scope values with optional whitespace', () => {
    expect(getScopes({ Scope: ['internal,admin'] })).toEqual(new Set(['internal', 'admin']));
    expect(getScopes({ Scope: ['internal, admin'] })).toEqual(new Set(['internal', 'admin']));
    expect(getScopes({ Scope: ['internal', 'admin'] })).toEqual(new Set(['internal', 'admin']));
    expect(getScopes({})).toEqual(new Set());
  });

  it('parseScopeList handles CLI-style input variants', () => {
    expect(parseScopeList(undefined)).toEqual([]);
    expect(parseScopeList('internal,admin')).toEqual(['internal', 'admin']);
    expect(parseScopeList(['internal,admin', 'public'])).toEqual(['internal', 'admin', 'public']);
    expect(parseScopeList(['internal, admin'])).toEqual(['internal', 'admin']);
    expect(parseScopeList('')).toEqual([]);
  });

  it('only treats line-start @Scope as a tag (inline mentions are description)', () => {
    // AdminController has `@Scope admin` at line start → tag is present.
    // AuthController has no @Scope → no tag.
    // UsersController references @Scope only via JSDoc on its bridgeAction method.
    const index = new AstIndex({
      projectRoot: FIXTURE,
      project: { tsConfigFilePath: 'tsconfig.json', rootDir: 'src' },
    });

    const admin = index.getClass('AdminController');
    expect(admin).toBeDefined();
    expect(getScopes(getTags(admin!))).toEqual(new Set(['admin']));

    const auth = index.getClass('AuthController');
    expect(auth).toBeDefined();
    expect(getScopes(getTags(auth!))).toEqual(new Set());
  });
});
