#!/usr/bin/env node
import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config/loader';
import { parseNestProject } from './parser';

interface CliOptions {
  project: string;
  out: string;
  config?: string;
}

function readPackageVersion(): string {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

async function run(options: CliOptions): Promise<void> {
  const projectRoot = path.resolve(options.project);
  const outPath = path.resolve(options.out);

  const { config, filePath } = await loadConfig({
    projectRoot,
    configPath: options.config,
  });

  console.log(`Project root: ${projectRoot}`);
  console.log(`Config file:  ${filePath}`);

  const document = parseNestProject({ projectRoot, config });

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(document, null, 2));

  const routeCount = Object.keys(document.paths).length;
  const operationCount = Object.values(document.paths).reduce(
    (acc, ops) => acc + Object.keys(ops).length,
    0,
  );
  const schemaCount = Object.keys(document.components?.schemas ?? {}).length;

  console.log(
    `Wrote ${outPath} (${routeCount} routes, ${operationCount} operations, ${schemaCount} schemas).`,
  );
}

const program = new Command();

program
  .name('nestparser')
  .description('Parse a NestJS project and emit an OpenAPI document.')
  .version(readPackageVersion())
  .option('-p, --project <path>', 'path to the NestJS project root', process.cwd())
  .option(
    '-o, --out <path>',
    'path to the OpenAPI JSON output file',
    path.resolve(process.cwd(), 'openapi.json'),
  )
  .option(
    '-c, --config <path>',
    'path to the nestparser config file (defaults to auto-discovery in the project root)',
  )
  .action(run);

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
