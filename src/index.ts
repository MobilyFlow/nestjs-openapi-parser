#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseNestProject } from './parser';

interface CliOptions {
  project: string;
  out: string;
}

function readPackageVersion(): string {
  const pkgPath = path.resolve(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
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
  .action(async (options: CliOptions) => {
    const projectPath = path.resolve(options.project);
    const outPath = path.resolve(options.out);

    console.log(`Parsing NestJS project: ${projectPath}`);
    console.log(`Writing OpenAPI document to: ${outPath}`);

    await parseNestProject({ projectPath, outPath });
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
