/**
 * Tiny dev server: renders the test-suite's OpenAPI snapshot in a Scalar UI.
 *
 *   yarn snapshot:serve              # http://localhost:8088
 *   SCALAR_PORT=9000 yarn snapshot:serve
 *
 * The snapshot file is read fresh on every request, so `yarn test -u` updates
 * are picked up without restarting the server.
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const SNAPSHOT_PATH = path.resolve(__dirname, '../tests/__snapshots__/openapi.snap.json');
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

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/openapi.json') {
    if (!existsSync(SNAPSHOT_PATH)) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end(`Snapshot not found at ${SNAPSHOT_PATH}. Run \`yarn test -u\` first.`);
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(SNAPSHOT_PATH));
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
  console.log(`Serving snapshot:     ${SNAPSHOT_PATH}`);
});
