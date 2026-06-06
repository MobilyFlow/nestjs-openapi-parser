import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { NestParserConfig } from './types';

const CANDIDATE_NAMES = [
  'nestparser.config.ts',
  'nestparser.config.mts',
  'nestparser.config.cts',
  'nestparser.config.mjs',
  'nestparser.config.cjs',
  'nestparser.config.js',
  'nestparser.config.json',
];

let tsxRegistered = false;

function ensureTsxRegistered(): void {
  if (tsxRegistered) return;
  // Register tsx's CommonJS require hook so we can `require('./foo.ts')`.
  // Imported lazily so JSON-only users don't pay for it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('tsx/cjs');
  tsxRegistered = true;
}

function findConfigFile(projectRoot: string, explicit?: string): string | undefined {
  if (explicit) {
    const resolved = path.isAbsolute(explicit) ? explicit : path.resolve(projectRoot, explicit);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config file not found: ${resolved}`);
    }
    return resolved;
  }
  for (const name of CANDIDATE_NAMES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function importConfig(filePath: string): Promise<unknown> {
  const ext = path.extname(filePath);

  if (ext === '.json') {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    ensureTsxRegistered();
  }

  if (ext === '.mjs' || ext === '.mts') {
    const mod = (await import(pathToFileURL(filePath).href)) as { default?: unknown };
    return mod.default ?? mod;
  }

  // .ts / .cts / .cjs / .js — CommonJS path (tsx's require hook covers .ts/.cts)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(filePath) as { default?: unknown };
  return mod.default ?? mod;
}

function isConfigShape(value: unknown): value is NestParserConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    'openapi' in value &&
    typeof (value as { openapi: unknown }).openapi === 'object'
  );
}

export interface LoadConfigOptions {
  projectRoot: string;
  /** Explicit path to a config file, overriding auto-discovery. */
  configPath?: string;
}

export interface LoadedConfig {
  config: NestParserConfig;
  filePath: string | undefined;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const filePath = findConfigFile(options.projectRoot, options.configPath);
  if (!filePath) {
    throw new Error(
      `No nestparser config found in ${options.projectRoot}. Expected one of: ${CANDIDATE_NAMES.join(', ')}.`,
    );
  }

  const raw = await importConfig(filePath);
  if (!isConfigShape(raw)) {
    throw new Error(
      `Config at ${filePath} does not export a valid NestParserConfig (missing 'openapi').`,
    );
  }
  return { config: raw, filePath };
}
