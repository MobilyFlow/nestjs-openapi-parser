import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseNestProject } from '../src/lib';
import type { OpenApiDocument } from '../src/types/openapi';

const FIXTURE = path.resolve(__dirname, 'fixtures/example-app');

async function buildFixtureDocument(): Promise<OpenApiDocument> {
  const { config } = await loadConfig({ projectRoot: FIXTURE });
  return parseNestProject({ projectRoot: FIXTURE, config });
}

describe('parseNestProject (library API)', () => {
  it('builds the expected OpenAPI document for the example app', async () => {
    const document = await buildFixtureDocument();
    await expect(JSON.stringify(document, null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/openapi.snap.json',
    );
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
});
