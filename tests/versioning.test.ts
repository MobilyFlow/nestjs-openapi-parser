import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project } from 'ts-morph';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseNestProject } from '../src/lib';
import { detectBootstrap, type BootstrapInfo } from '../src/parser/bootstrap';
import type { NestParserConfig } from '../src/lib';
import type { OpenApiDocument } from '../src/types/openapi';

// Self-validation uses a native dynamic import of an ESM-only package vitest's
// VM can't host; stub it (the CLI tests cover real validation).
vi.mock('../src/validate', () => ({
  validateDocument: async () => ({ valid: true, errors: [] }),
}));

// A throwaway NestJS project written to disk so AstIndex (which reads from the
// filesystem via a real tsconfig) can index it. Decorator imports don't need to
// resolve — ts-morph parses regardless, and controllers/decorators are matched
// by name. main.ts carries the bootstrap calls the detector reads.
const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'commonjs',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    skipLibCheck: true,
    noEmit: true,
  },
  include: ['src'],
});

const MAIN_TS = `
import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, prefix: 'v', defaultVersion: '1' });
  await app.listen(3000);
}
bootstrap();
`;

const CATS_CONTROLLER = `
import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Get()
  findAll(): string { return 'cats'; }

  @Get('legacy')
  @Version('2')
  legacy(): string { return 'legacy'; }

  @Get('multi')
  @Version(['1', '2'])
  multi(): string { return 'multi'; }

  @Get('ping')
  @Version(VERSION_NEUTRAL)
  ping(): string { return 'pong'; }

  @Get('mixed')
  @Version(['1', VERSION_NEUTRAL])
  mixed(): string { return 'mixed'; }
}
`;

// No @Version → falls back to the detected defaultVersion ('1').
const DOGS_CONTROLLER = `
import { Controller, Get } from '@nestjs/common';

@Controller('dogs')
export class DogsController {
  @Get()
  findAll(): string { return 'dogs'; }
}
`;

// Controller-level version via the options-object form `@Controller({ path,
// version })` — NestJS carries the controller version here, not in a @Version
// class decorator. A VERSION_NEUTRAL method opts back out of the version.
const ADMIN_CONTROLLER = `
import { Controller, Get, Param, Version, VERSION_NEUTRAL } from '@nestjs/common';

@Controller({ path: 'admin/projects', version: '5' })
export class AdminProjectController {
  @Get()
  @Version(VERSION_NEUTRAL)
  list(): string { return 'list'; }

  @Get(':projectId')
  get(@Param('projectId') projectId: string): string { return projectId; }
}
`;

let projectRoot: string;

beforeAll(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nestparser-versioning-'));
  const src = path.join(projectRoot, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), TSCONFIG);
  fs.writeFileSync(path.join(src, 'main.ts'), MAIN_TS);
  fs.writeFileSync(path.join(src, 'cats.controller.ts'), CATS_CONTROLLER);
  fs.writeFileSync(path.join(src, 'dogs.controller.ts'), DOGS_CONTROLLER);
  fs.writeFileSync(path.join(src, 'admin.controller.ts'), ADMIN_CONTROLLER);
});

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

const baseConfig: NestParserConfig = {
  openapi: { title: 'Versioned API', version: '1.0.0' },
};

function build(overrides: Partial<NestParserConfig> = {}): Promise<OpenApiDocument> {
  return parseNestProject({ projectRoot, config: { ...baseConfig, ...overrides } });
}

describe('bootstrap auto-detection', () => {
  it('detects setGlobalPrefix and URI versioning from main.ts', async () => {
    const doc = await build();
    const paths = Object.keys(doc.paths);

    // no method @Version → detected defaultVersion '1' + global prefix
    expect(doc.paths['/api/v1/cats']?.get).toBeDefined();
    // method @Version('2') overrides the default version
    expect(doc.paths['/api/v2/cats/legacy']?.get).toBeDefined();
    // @Version(['1','2']) → one path per version
    expect(doc.paths['/api/v1/cats/multi']?.get).toBeDefined();
    expect(doc.paths['/api/v2/cats/multi']?.get).toBeDefined();
    // @Version(VERSION_NEUTRAL) → no version segment
    expect(doc.paths['/api/cats/ping']?.get).toBeDefined();
    // @Version(['1', VERSION_NEUTRAL]) → both the v1 path and the unversioned one
    expect(doc.paths['/api/v1/cats/mixed']?.get).toBeDefined();
    expect(doc.paths['/api/cats/mixed']?.get).toBeDefined();
    // no @Version → detected defaultVersion '1'
    expect(doc.paths['/api/v1/dogs']?.get).toBeDefined();

    // nothing unversioned leaked for the versioned routes
    expect(paths).not.toContain('/api/cats');
    expect(paths).not.toContain('/api/dogs');
  });

  it('reads controller-level version and path from @Controller({ path, version })', async () => {
    const doc = await build();

    // @Version(VERSION_NEUTRAL) method keeps the full controller path, unversioned
    expect(doc.paths['/api/admin/projects']?.get).toBeDefined();
    // plain method inherits the controller's version '5' — path must be preserved
    expect(doc.paths['/api/v5/admin/projects/{projectId}']?.get).toBeDefined();

    // the controller path must never be dropped (the bug: object form lost it)
    expect(doc.paths['/api']).toBeUndefined();
    expect(doc.paths['/api/v1/{projectId}']).toBeUndefined();
  });

  it('lets an explicit globalPrefix override the detected one', async () => {
    const doc = await build({ project: { globalPrefix: 'svc' } });
    expect(doc.paths['/svc/v1/cats']?.get).toBeDefined();
    expect(doc.paths['/api/v1/cats']).toBeUndefined();
  });

  it('disables versioning when project.versioning is false', async () => {
    const doc = await build({ project: { versioning: false } });
    // global prefix still detected, but no version segments
    expect(doc.paths['/api/cats']?.get).toBeDefined();
    expect(doc.paths['/api/v1/cats']).toBeUndefined();
  });
});

describe('detectBootstrap', () => {
  // Detect from in-memory files, listed in traversal order; `main.ts` calls
  // NestFactory.create so it's scanned first regardless of its position.
  function detect(files: Record<string, string>): { info: BootstrapInfo; warnings: string[] } {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFiles = Object.entries(files).map(([name, code]) =>
      project.createSourceFile(`src/${name}`, code),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const info = detectBootstrap(sourceFiles);
      return { info, warnings: warn.mock.calls.map(([msg]) => String(msg)) };
    } finally {
      warn.mockRestore();
    }
  }

  const BOOT = 'const app = NestFactory.create(AppModule);';

  it("doesn't fall back to another file when main.ts's prefix isn't a literal", () => {
    const { info, warnings } = detect({
      'other.ts': "app.setGlobalPrefix('other');",
      'main.ts': `${BOOT} app.setGlobalPrefix(process.env.PREFIX);`,
    });
    expect(info.globalPrefix).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('process.env.PREFIX')]);
  });

  it("skips versioning (no URI guess, no fallback) when main.ts's options aren't a literal", () => {
    const { info, warnings } = detect({
      'other.ts': "app.enableVersioning({ type: VersioningType.URI, defaultVersion: '9' });",
      'main.ts': `${BOOT} app.enableVersioning(versioningOptions);`,
    });
    expect(info.versioning).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('versioningOptions')]);
  });

  it('skips versioning when the `type` option is dynamic', () => {
    const { info, warnings } = detect({
      'main.ts': `${BOOT} app.enableVersioning({ type: config.versioningType, defaultVersion: '1' });`,
    });
    expect(info.versioning).toBeUndefined();
    expect(warnings).toEqual([expect.stringContaining('versioning was skipped')]);
  });

  it('keeps the readable options and warns about each dynamic one', () => {
    const { info, warnings } = detect({
      'main.ts': `${BOOT} app.enableVersioning({
        ...baseOptions,
        type: VersioningType.URI,
        prefix: process.env.VERSION_PREFIX,
        defaultVersion: ['2', process.env.API_VERSION],
      });`,
    });
    expect(info.versioning).toEqual({ type: 'uri', prefix: 'v', defaultVersion: ['2'] });
    expect(warnings).toEqual([
      expect.stringContaining('...baseOptions'),
      expect.stringContaining('`prefix` was left at its default'),
      expect.stringContaining('non-literal entries were dropped'),
    ]);
  });

  it('reads fully literal options without warnings', () => {
    const { info, warnings } = detect({
      'main.ts': `${BOOT} app.enableVersioning({ type: VersioningType.URI, prefix: false, defaultVersion: ['1', VERSION_NEUTRAL] });`,
    });
    expect(info.versioning).toEqual({ type: 'uri', prefix: '', defaultVersion: ['1', ''] });
    expect(warnings).toEqual([]);
  });
});
