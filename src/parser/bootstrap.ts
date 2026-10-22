import { Node, ObjectLiteralExpression, SourceFile, SyntaxKind } from 'ts-morph';
import type { VersioningConfig } from '../config/types';

export interface ResolvedVersioning {
  type: 'uri' | 'header' | 'media-type' | 'custom';
  /** URI version prefix (default `'v'`). */
  prefix: string;
  /** Default versions for routes without an explicit `@Version`, normalized to an array. */
  defaultVersion: string[];
}

export interface BootstrapInfo {
  globalPrefix?: string;
  versioning?: ResolvedVersioning;
}

const VERSIONING_TYPES: Record<string, ResolvedVersioning['type']> = {
  URI: 'uri',
  HEADER: 'header',
  MEDIA_TYPE: 'media-type',
  CUSTOM: 'custom',
};

/**
 * Statically read the NestJS bootstrap configuration from source — the
 * `app.setGlobalPrefix(...)` and `app.enableVersioning(...)` calls — so the
 * generator can mirror them without booting the app.
 *
 * Best-effort: calls whose arguments aren't literals are skipped (with a
 * warning — an explicit config field is the escape hatch).
 * Methods are matched by name only, so any `app`-like receiver works.
 * The first call of each kind wins — even an unreadable one, so a dynamic
 * `setGlobalPrefix(process.env.PREFIX)` in `main.ts` doesn't fall through to a
 * literal call in some other file.
 *
 * `sourceFiles` is already scoped to the project's rootDir with excludeSuffixes
 * applied (so `*.spec.ts`/`*.d.ts` are out), but `*.e2e-spec.ts` test apps and
 * the like can still slip through. To keep a test app's `setGlobalPrefix` from
 * beating `main.ts`, the file that calls `NestFactory.create(...)` is scanned
 * first; everything else is a fallback.
 */
export function detectBootstrap(sourceFiles: SourceFile[]): BootstrapInfo {
  const info: BootstrapInfo = {};
  // Tracked apart from `info.globalPrefix` / `info.versioning`, which stay
  // undefined when the call's argument can't be read statically.
  let prefixSeen = false;
  let versioningSeen = false;

  const bootstrapFiles: SourceFile[] = [];
  const others: SourceFile[] = [];
  for (const sourceFile of sourceFiles) {
    (callsNestFactory(sourceFile) ? bootstrapFiles : others).push(sourceFile);
  }

  for (const sourceFile of [...bootstrapFiles, ...others]) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;

      const name = callee.getName();

      if (name === 'setGlobalPrefix' && !prefixSeen) {
        prefixSeen = true;
        const arg = call.getArguments()[0];
        if (arg && Node.isStringLiteral(arg)) {
          info.globalPrefix = arg.getLiteralValue();
        } else if (arg) {
          warnDynamic('setGlobalPrefix', arg);
        }
        // TODO: support `app.setGlobalPrefix('...', { exclude: ['/health', { path: 'robots.txt', method: RequestMethod.GET }] })`
      } else if (name === 'enableVersioning' && !versioningSeen) {
        versioningSeen = true;
        const arg = call.getArguments()[0];
        // Don't guess the strategy from an options variable: assuming URI would
        // add (or omit) version segments NestJS doesn't serve.
        if (arg && !Node.isObjectLiteralExpression(arg)) warnDynamic('enableVersioning', arg);
        else info.versioning = readVersioning(arg);
      }
    }

    if (prefixSeen && versioningSeen) break;
  }

  return info;
}

/** True when a source file calls `NestFactory.create(...)` */
function callsNestFactory(sourceFile: SourceFile): boolean {
  return sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    const callee = call.getExpression();
    return (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'create' &&
      callee.getExpression().getText() === 'NestFactory'
    );
  });
}

function warnDynamic(method: string, arg: Node): void {
  console.warn(
    `[nestparser] app.${method}(...) argument "${arg.getText()}" isn't a static literal, ` +
      `so it was skipped. Set it explicitly in the parser config if it affects route URLs.`,
  );
}

/** Turn a resolved config back into the same shape the detector produces. */
export function normalizeVersioning(config: VersioningConfig): ResolvedVersioning {
  return {
    type: config.type ?? 'uri',
    prefix: config.prefix ?? 'v',
    defaultVersion: toArray(config.defaultVersion),
  };
}

function warnDynamicOption(node: Node, consequence: string): void {
  console.warn(
    `[nestparser] app.enableVersioning(...) option "${node.getText()}" isn't a static ` +
      `literal, so ${consequence}. Set \`project.versioning\` explicitly in the parser config.`,
  );
}

/**
 * Read an `enableVersioning(...)` options object literal. Unreadable members are
 * reported: a dynamic `type` drops versioning altogether (the strategy decides
 * whether paths change at all), while a dynamic `prefix` / `defaultVersion` (or
 * a spread) only falls back to the default for that field.
 */
function readVersioning(arg: ObjectLiteralExpression | undefined): ResolvedVersioning | undefined {
  // `enableVersioning()` with no options defaults to URI versioning.
  const result: ResolvedVersioning = { type: 'uri', prefix: 'v', defaultVersion: [] };
  if (!arg) return result;

  for (const prop of arg.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) warnDynamicOption(prop, 'it was ignored');
  }

  const type = propertyInitializer(arg, 'type');
  if (type) {
    // `VersioningType.URI` reads the member name; fall back to a plain string.
    const resolved = Node.isPropertyAccessExpression(type)
      ? VERSIONING_TYPES[type.getName()]
      : Node.isStringLiteral(type)
        ? VERSIONING_TYPES[type.getLiteralValue().toUpperCase()]
        : undefined;
    if (!resolved) {
      warnDynamicOption(type, 'versioning was skipped');
      return undefined;
    }
    result.type = resolved;
  }

  const prefix = propertyInitializer(arg, 'prefix');
  if (prefix) {
    // `prefix: false` disables the prefix in NestJS.
    if (Node.isStringLiteral(prefix)) result.prefix = prefix.getLiteralValue();
    else if (prefix.getKind() === SyntaxKind.FalseKeyword) result.prefix = '';
    else warnDynamicOption(prefix, `\`prefix\` was left at its default '${result.prefix}'`);
  }

  const def = propertyInitializer(arg, 'defaultVersion');
  if (def) {
    const nodes = Node.isArrayLiteralExpression(def) ? def.getElements() : [def];
    if (nodes.some((n) => readVersionValue(n) === undefined)) {
      warnDynamicOption(def, 'its non-literal entries were dropped');
    }
    result.defaultVersion = readVersionValues(def);
  }

  return result;
}

/** Initializer of a `name: value` member of an object literal, or undefined. */
function propertyInitializer(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const prop = obj.getProperty(name);
  return Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
}

/**
 * Read a NestJS version value node — a string literal, the `VERSION_NEUTRAL`
 * identifier (→ `''`, meaning no version segment), or an array mixing both — into
 * a deduped version list. Non-literal / dynamic entries are dropped (best-effort).
 */
export function readVersionValues(node: Node): string[] {
  const nodes = Node.isArrayLiteralExpression(node) ? node.getElements() : [node];
  return [...new Set(nodes.map(readVersionValue).filter((v): v is string => v !== undefined))];
}

/** A single version entry: a string literal, or `VERSION_NEUTRAL` → `''`. */
function readVersionValue(node: Node): string | undefined {
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isIdentifier(node) && node.getText() === 'VERSION_NEUTRAL') return '';
  return undefined;
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
