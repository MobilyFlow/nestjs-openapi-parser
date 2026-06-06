import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseNestProject } from '../src/lib';

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
    const libDoc = parseNestProject({ projectRoot: FIXTURE, config });

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
  });
});
