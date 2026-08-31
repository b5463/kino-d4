import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT ?? 4400);
// Loopback, not every interface. This serves build output and proxies to the
// Roll API with no authentication of its own, so on a café or conference
// network `0.0.0.0` hands both to anyone on the subnet. Set HOST=0.0.0.0
// deliberately to reach it from a phone or another machine.
const host = process.env.HOST ?? '127.0.0.1';
// Twin's Roll bridge and Studio's Roll panel call same-origin /api — in dev
// that is the Roll API on :3000 (matches the vite proxies). Issue #86.
const apiTarget = process.env.KINO_API_URL ?? 'http://localhost:3000';
const roots = [
  { prefix: '/studio', directory: join(process.cwd(), 'apps', 'studio', 'dist') },
  { prefix: '/dev/twin', directory: join(process.cwd(), 'apps', 'twin', 'dist') },
];
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
};

createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const upstream = new URL(request.url ?? '/', apiTarget);
    const proxied = httpRequest(
      upstream,
      { method: request.method, headers: { ...request.headers, host: upstream.host } },
      (res) => {
        response.writeHead(res.statusCode ?? 502, res.headers);
        res.pipe(response);
      },
    );
    proxied.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain' });
      response.end(`Roll API not reachable at ${apiTarget} — start it with: npm run dev -w @kino/api`);
    });
    request.pipe(proxied);
    return;
  }
  const root = roots.find((candidate) => pathname === candidate.prefix || pathname.startsWith(`${candidate.prefix}/`));
  if (!root) { response.writeHead(404).end('Open /studio/ or /dev/twin/'); return; }
  if (pathname === root.prefix) { response.writeHead(308, { Location: `${root.prefix}/` }).end(); return; }
  const relative = decodeURIComponent(pathname.slice(root.prefix.length + 1));
  const safe = normalize(relative).replace(/^(\.\.(?:[/\\]|$))+/, '');
  let file = join(root.directory, safe || 'index.html');
  if (!existsSync(file) || !statSync(file).isFile()) file = join(root.directory, 'index.html');
  if (!file.startsWith(root.directory) || !existsSync(file)) { response.writeHead(404).end('Build output missing. Run npm run build first.'); return; }
  response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(response);
}).listen(port, host, () => {
  console.log(`KINO Studio: http://localhost:${port}/studio/`);
  console.log(`KINO Twin:   http://localhost:${port}/dev/twin/`);
  if (host !== '127.0.0.1') console.log(`bound to ${host} — reachable from other machines on this network`);
});
