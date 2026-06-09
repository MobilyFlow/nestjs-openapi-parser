import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, parseNestProject } from '../src/lib';

// The in-process parseNestProject call below self-validates via a native dynamic
// import of an ESM-only package that vitest's VM can't host; stub it. The spawned
// CLI runs in a real Node process, so its validation is the genuine one.
vi.mock('../src/validate', () => ({
  validateDocument: async () => ({ valid: true, errors: [] }),
}));

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.resolve(__dirname, 'fixtures/example-app');
const TMP = path.resolve(__dirname, '.tmp');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const CLI = path.join(ROOT, 'src/cli.ts');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('node', [TSX, CLI, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('nestparser CLI', () => {
  it('produces the same document as the library API', async () => {
    mkdirSync(TMP, { recursive: true });
    const out = path.join(TMP, 'cli-output.json');

    const result = runCli(['--project', FIXTURE, '--out', out]);
    expect(result.status, result.stderr).toBe(0);

    const cliJson = JSON.parse(readFileSync(out, 'utf-8'));
    const { config } = await loadConfig({ projectRoot: FIXTURE });
    const libDoc = await parseNestProject({ projectRoot: FIXTURE, config });

    expect(cliJson).toEqual(libDoc);
  });

  it('prints --version', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints --help with both --project and --out options', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--project');
    expect(result.stdout).toContain('--out');
    expect(result.stdout).toContain('--config');
    expect(result.stdout).toContain('--scope');
  });

  it('self-validates the generated document (exits cleanly on the valid fixture)', () => {
    mkdirSync(TMP, { recursive: true });
    const out = path.join(TMP, 'cli-validate.json');

    // parseNestProject validates its output and throws on an invalid document, so
    // a zero exit on the real fixture proves the generated spec is valid OpenAPI.
    const result = runCli(['--project', FIXTURE, '--out', out]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Wrote');
  });

  it('--scope admin emits the AdminController and AdminMeta schema', () => {
    mkdirSync(TMP, { recursive: true });
    const out = path.join(TMP, 'cli-scope-admin.json');

    const result = runCli(['--project', FIXTURE, '--out', out, '--scope', 'admin']);
    expect(result.status, result.stderr).toBe(0);

    const doc = JSON.parse(readFileSync(out, 'utf-8'));
    expect(doc.paths['/api/admin/whoami']).toBeDefined();
    expect(doc.components.schemas).toHaveProperty('AdminMeta');
  });

  it('--scope is repeatable: --scope internal --scope admin acts as the union', () => {
    mkdirSync(TMP, { recursive: true });
    const out = path.join(TMP, 'cli-scope-multi.json');

    const result = runCli([
      '--project',
      FIXTURE,
      '--out',
      out,
      '--scope',
      'internal',
      '--scope',
      'admin',
    ]);
    expect(result.status, result.stderr).toBe(0);

    const doc = JSON.parse(readFileSync(out, 'utf-8'));
    expect(doc.paths['/api/admin/whoami']).toBeDefined();
    expect(doc.paths['/api/users/{id}/bridge']).toBeDefined();
  });
});
