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
    typeof (value as { openapi: unknown }).openapi === 'object' &&
    (value as { openapi: unknown }).openapi !== null
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Default `openapi.title`/`version` for a project — from its `package.json`
 * (`name`/`version`) when available, else generic fallbacks. Used both when no
 * config file exists and to fill in either field a config file leaves out.
 */
function resolveOpenApiDefaults(projectRoot: string): { title: string; version: string } {
  let title = 'API';
  let version = '1.0.0';

  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      if (nonEmptyString(pkg.name)) title = pkg.name;
      if (nonEmptyString(pkg.version)) version = pkg.version;
    } catch {
      // Malformed package.json — keep the generic fallbacks.
    }
  }

  return { title, version };
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
    // Auto-discovery found nothing (an explicit --config miss already threw):
    // fall back to a default config so the doc can still be generated.
    const { title, version } = resolveOpenApiDefaults(options.projectRoot);
    console.warn(
      `[nestparser] No config file found in ${options.projectRoot}; ` +
        `using defaults (title="${title}", version="${version}"). ` +
        `Add one of ${CANDIDATE_NAMES.join(', ')} to customize.`,
    );
    return { config: { openapi: { title, version } }, filePath: undefined };
  }

  const raw = await importConfig(filePath);
  if (!isConfigShape(raw)) {
    throw new Error(
      `Config at ${filePath} does not export a valid NestParserConfig (missing 'openapi').`,
    );
  }

  // Fill in `title`/`version` from package.json (or generic defaults) when the
  // config omits either, rather than failing — same fallback as the no-config path.
  const missing: string[] = [];
  if (!nonEmptyString(raw.openapi.title)) missing.push('title');
  if (!nonEmptyString(raw.openapi.version)) missing.push('version');
  if (missing.length) {
    const defaults = resolveOpenApiDefaults(options.projectRoot);
    if (!nonEmptyString(raw.openapi.title)) raw.openapi.title = defaults.title;
    if (!nonEmptyString(raw.openapi.version)) raw.openapi.version = defaults.version;
    console.warn(
      `[nestparser] Config at ${filePath} is missing ${missing.map((m) => `openapi.${m}`).join(', ')}; ` +
        `using defaults (title="${raw.openapi.title}", version="${raw.openapi.version}").`,
    );
  }

  return { config: raw, filePath };
}
