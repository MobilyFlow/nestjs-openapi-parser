# Project: nestjs-openapi-parser

## Goal

A standalone CLI that consumes a NestJS project's TypeScript source code and emits an OpenAPI 3.x document. The parser is **purely static** — it uses [ts-morph](https://ts-morph.com/) to walk the AST. It does **not** import NestJS, instantiate the application, or rely on `reflect-metadata` at runtime.

Published as `nestjs-openapi-parser` on npm, invoked as `nestparser` (or via `npx nestparser`).

## Tech stack

- **Package manager**: Yarn Berry (v4) with `nodeLinker: node-modules` (see `.yarnrc.yml`).
- **Language**: TypeScript, `target: ES2022`, `module: commonjs`.
- **AST**: `ts-morph` — the only AST tool. Do not introduce `@nestjs/*` runtime deps or `reflect-metadata`.
- **CLI**: `commander`.
- **Dev runner**: `tsx` (no compile during dev).
- **Build**: `tsc` → `dist/`.
- **Lint**: ESLint 9 flat config (`eslint.config.mjs`) + `typescript-eslint`.
- **Format**: Prettier (single quotes, trailing commas, 100 cols).

## Layout

```
src/
  index.ts         # CLI entrypoint — keeps the shebang #!/usr/bin/env node
  parser/
    index.ts       # parseNestProject(options) — main parsing entry
```

`src/index.ts` MUST stay the file referenced by the `bin` field in `package.json`. The shebang is required for `npx nestparser` to work post-install — TypeScript preserves it through compilation.

## Common commands

```sh
yarn dev --project ./fixture --out /tmp/openapi.json   # run via tsx, no compile
yarn build                                              # tsc → dist/
yarn start --help                                       # run compiled output
yarn lint
yarn format
```

## Conventions

- One responsibility per file. The CLI layer (`src/index.ts`) only parses flags and delegates to `parser/`. No business logic in `index.ts`.
- New parser features go under `src/parser/<feature>.ts` with focused, testable functions over methods on giant classes.
- Read `package.json` at runtime via `fs.readFileSync` + `JSON.parse`, not via `import '../package.json'` — keeps `rootDir: src` clean.
- Never commit `dist/` — it's gitignored and only produced by `yarn build` / `prepublishOnly`.
- Always run `yarn lint` and `yarn format:check` before committing.

## Out of scope (for now)

- Tests — no test framework yet. Vitest will land alongside the first real parser slice.
- CI — none yet.
- Publishing — not published; do not run `yarn publish` until v0.1.0 is ready.
