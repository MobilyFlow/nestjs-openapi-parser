/**
 * Tiny dev server: renders an OpenAPI snapshot in a Scalar UI.
 *
 *   yarn snapshot:serve                              # interactive picker
 *   yarn snapshot:serve openapi.admin.snap.json      # explicit file (relative to tests/__snapshots__/)
 *   yarn snapshot:serve /tmp/some-spec.json          # explicit absolute path
 *   SCALAR_PORT=9000 yarn snapshot:serve
 *
 * The snapshot file is read fresh on every request, so `yarn test -u` updates
 * are picked up without restarting the server.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import prompts from 'prompts';

const SNAPSHOTS_DIR = path.resolve(__dirname, '../tests/__snapshots__');
const PORT = Number(process.env.SCALAR_PORT) || 8088;

const HTML = `<!doctype html>
<html>
  <head>
    <title>nestparser fixture — API reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

function resolveExplicit(arg: string): string {
  // Absolute or relative-to-cwd path wins if it exists; otherwise treat as a
  // basename in tests/__snapshots__/.
  const direct = path.resolve(arg);
  if (existsSync(direct) && statSync(direct).isFile()) return direct;

  const candidate = path.join(SNAPSHOTS_DIR, arg);
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  throw new Error(
    `Snapshot not found: tried "${direct}" and "${candidate}". Pass an absolute path or a basename present in ${SNAPSHOTS_DIR}.`,
  );
}

async function pickInteractively(): Promise<string> {
  if (!existsSync(SNAPSHOTS_DIR)) {
    throw new Error(
      `Snapshots directory does not exist: ${SNAPSHOTS_DIR}. Run \`yarn test\` first.`,
    );
  }
  const files = readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No JSON snapshots found under ${SNAPSHOTS_DIR}. Run \`yarn test\` first.`);
  }
  if (files.length === 1) return path.join(SNAPSHOTS_DIR, files[0]);

  const answer = await prompts({
    type: 'select',
    name: 'file',
    message: 'Which snapshot do you want to serve?',
    choices: files.map((f) => ({ title: f, value: f })),
  });

  if (!answer.file) {
    // User aborted (Ctrl+C / Esc).
    process.exit(0);
  }
  return path.join(SNAPSHOTS_DIR, answer.file as string);
}

async function resolveSnapshotPath(): Promise<string> {
  const args = process.argv.slice(2);
  if (args.length > 0) return resolveExplicit(args[0]);
  return pickInteractively();
}

async function main(): Promise<void> {
  const snapshotPath = await resolveSnapshotPath();

  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/openapi.json') {
      if (!existsSync(snapshotPath)) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end(`Snapshot disappeared at ${snapshotPath}. Run \`yarn test -u\` first.`);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(readFileSync(snapshotPath));
      return;
    }

    if (url === '/' || url === '/reference') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`Scalar API reference: http://localhost:${PORT}`);
    console.log(`OpenAPI spec:         http://localhost:${PORT}/openapi.json`);
    console.log(`Serving snapshot:     ${snapshotPath}`);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
