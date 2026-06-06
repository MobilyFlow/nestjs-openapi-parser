# nestjs-openapi-parser

CLI that statically parses a NestJS project with [ts-morph](https://ts-morph.com/) and emits an OpenAPI 3.x document — no runtime, no decorators reflected, no app boot needed.

> Status: scaffolding only. The actual parser is not implemented yet.

## Install

After publish:

```sh
npx nestparser --project ./path/to/nest/project --out openapi.json
```

Or install globally:

```sh
npm install -g nestjs-openapi-parser
nestparser --help
```

## Usage

```
nestparser [options]

Options:
  -V, --version           output the version number
  -p, --project <path>    path to the NestJS project root (default: cwd)
  -o, --out <path>        path to the OpenAPI JSON output file (default: ./openapi.json)
  -h, --help              display help
```

Examples:

```sh
# Parse current directory, write to ./openapi.json
nestparser

# Explicit paths
nestparser --project ./apps/api --out ./dist/openapi.json
```

## Development

Requirements: Node.js >= 18, Yarn 4 (Berry).

```sh
yarn install
yarn dev --help          # run CLI via tsx
yarn build               # compile to dist/
yarn lint                # eslint
yarn format              # prettier --write
```

## License

MIT
