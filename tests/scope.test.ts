import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  filterScopedComments,
  getScopes,
  getTags,
  loadConfig,
  parseNestProject,
  parseScopeList,
} from '../src/lib';
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

  describe('filterScopedComments', () => {
    it('keeps a multi-line fragment when its scope is active', () => {
      const text = ['Lead.', '', '<internal>', 'kept', '</internal>'].join('\n');
      expect(filterScopedComments(text, new Set(['internal']))).toBe('Lead.\n\nkept');
    });

    it('drops a multi-line fragment when no scope is active', () => {
      const text = ['Lead.', '', '<internal>', 'gone', '</internal>'].join('\n');
      expect(filterScopedComments(text, new Set())).toBe('Lead.');
    });

    it('keeps matching siblings, drops non-matching ones', () => {
      const text = [
        'Top.',
        '',
        '<internal>internal-line</internal>',
        '',
        '<admin>admin-line</admin>',
      ].join('\n');
      expect(filterScopedComments(text, new Set(['internal']))).toBe('Top.\n\ninternal-line');
      expect(filterScopedComments(text, new Set(['admin']))).toBe('Top.\n\nadmin-line');
      expect(filterScopedComments(text, new Set(['internal', 'admin']))).toBe(
        'Top.\n\ninternal-line\n\nadmin-line',
      );
    });

    it('supports inline fragments mid-paragraph', () => {
      const text = 'Foo <admin>(admin: extra)</admin> bar.';
      expect(filterScopedComments(text, new Set(['admin']))).toBe('Foo (admin: extra) bar.');
      expect(filterScopedComments(text, new Set())).toBe('Foo  bar.');
    });

    it('passes plain text through unchanged', () => {
      const text = 'Just a regular description.';
      expect(filterScopedComments(text, new Set())).toBe(text);
      expect(filterScopedComments(text, new Set(['anything']))).toBe(text);
    });

    it('collapses 3+ blank lines and trims ends', () => {
      const text = '\n\n\n\nLead.\n\n\n\n<internal>x</internal>\n\n\n\n';
      expect(filterScopedComments(text, new Set(['internal']))).toBe('Lead.\n\nx');
    });

    it('returns empty string when everything is filtered out', () => {
      const text = '<internal>only-internal</internal>';
      expect(filterScopedComments(text, new Set())).toBe('');
    });

    it('throws on nested fragments (same name)', () => {
      const text = '<a>x<a>y</a>z</a>';
      expect(() => filterScopedComments(text, new Set())).toThrow(/nested/i);
    });

    it('throws on nested fragments (different name)', () => {
      const text = '<a>x<b>y</b>z</a>';
      expect(() => filterScopedComments(text, new Set())).toThrow(/nested/i);
    });

    it('throws on a mismatched closing tag', () => {
      const text = '<a>x</b>';
      expect(() => filterScopedComments(text, new Set())).toThrow(/mismatched/i);
    });

    it('throws on an unclosed opening tag', () => {
      const text = '<a>missing close';
      expect(() => filterScopedComments(text, new Set())).toThrow(/unclosed/i);
    });

    it('throws on an unmatched closing tag (no open)', () => {
      const text = 'x</a> y';
      expect(() => filterScopedComments(text, new Set())).toThrow(/unmatched/i);
    });

    it('includes the itemPath in error messages', () => {
      expect(() => filterScopedComments('<a>oops', new Set(), { itemPath: 'User.email' })).toThrow(
        /User\.email/,
      );
    });
  });

  describe('filterScopedComments with a knownScopes vocabulary', () => {
    const known = new Set(['internal', 'admin']);

    it('passes ordinary angle-bracket prose through verbatim (no throw)', () => {
      const cases = [
        'Returns the `<id>` of the created user.',
        'A list of names, e.g. Array<string>.',
        'Pass your <token> in the header.',
        'Wrap in <b>bold</b> for emphasis.',
      ];
      for (const text of cases) {
        expect(filterScopedComments(text, new Set(), { knownScopes: known })).toBe(text);
      }
    });

    it('still filters fragments whose name is a known scope', () => {
      const text = 'Lead. <internal>secret</internal> <admin>(admin)</admin>';
      expect(filterScopedComments(text, new Set(['internal']), { knownScopes: known })).toBe(
        'Lead. secret',
      );
      expect(filterScopedComments(text, new Set(), { knownScopes: known })).toBe('Lead.');
    });

    it('treats an unclosed non-scope tag as literal text instead of throwing', () => {
      expect(filterScopedComments('Array<string> only', new Set(), { knownScopes: known })).toBe(
        'Array<string> only',
      );
    });

    it('still throws on a malformed fragment whose name IS a known scope', () => {
      expect(() =>
        filterScopedComments('open <internal> but never closed', new Set(['internal']), {
          knownScopes: known,
          itemPath: 'User.email',
        }),
      ).toThrow(/Unclosed scope fragment <internal>.*User\.email/);
    });

    it('keeps a known-scope fragment that wraps non-scope prose inside it', () => {
      const text = 'Doc. <internal>see Array<string> details</internal>';
      expect(filterScopedComments(text, new Set(['internal']), { knownScopes: known })).toBe(
        'Doc. see Array<string> details',
      );
    });
  });

  describe('scoped descriptions in the fixture', () => {
    it('drops all fragments when no scope is active', async () => {
      const { config } = await loadConfig({ projectRoot: FIXTURE });
      const doc = parseNestProject({ projectRoot: FIXTURE, config });
      const user = doc.components?.schemas?.User as {
        description: string;
        properties: { email: { description: string } };
      };
      expect(user.description).toBe('A registered user.');
      expect(user.properties.email.description).toBe("The user's contact email.");
      const health = doc.paths['/api/health'].get as { description: string };
      expect(health.description).toBe('Liveness probe.');
    });

    it("appends internal paragraphs when scopes: ['internal']", async () => {
      const { config } = await loadConfig({ projectRoot: FIXTURE });
      const doc = parseNestProject({
        projectRoot: FIXTURE,
        config: { ...config, scopes: ['internal', 'admin'] },
      });
      const user = doc.components?.schemas?.User as {
        description: string;
        properties: { email: { description: string } };
      };
      expect(user.description).toContain('A registered user.');
      expect(user.description).toContain('Internal: lookup is by `id`');
      expect(user.description).toContain('Admin: rows with `role=ADMIN`');
      expect(user.properties.email.description).toContain('OTP delivery target');
      const health = doc.paths['/api/health'].get as { description: string };
      expect(health.description).toContain('in-memory uptime');
    });

    it("includes only admin-tagged fragments when scopes: ['admin']", async () => {
      const { config } = await loadConfig({ projectRoot: FIXTURE });
      const doc = parseNestProject({
        projectRoot: FIXTURE,
        config: { ...config, scopes: ['admin'] },
      });
      const user = doc.components?.schemas?.User as {
        description: string;
        properties: { email: { description: string } };
      };
      expect(user.description).toContain('Admin: rows with `role=ADMIN`');
      expect(user.description).not.toContain('lookup is by `id`');
      expect(user.properties.email.description).toBe("The user's contact email.");
    });
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
