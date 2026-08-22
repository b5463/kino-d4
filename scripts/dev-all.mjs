// One-command development stack (issue #88): infra services, database
// migration, then every dev server with prefixed output in a single
// terminal. Ctrl+C stops the node processes; the docker services stay up
// (they are shared state — stop them with docker compose when you mean it).
//
//   npm run dev:all             api :3000, worker, roll-web :5173,
//                               twin :5174, studio :5175
//   npm run dev:all -- --daemon also start the firmware build daemon :5177
//   npm run dev:all -- --only api,twin
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const only = onlyArg ? (onlyArg.split('=')[1] ?? process.argv[process.argv.indexOf(onlyArg) + 1] ?? '').split(',').filter(Boolean) : null;

const SERVERS = [
  { name: 'api', color: 36, argv: [tsx, 'src/dev.ts'], cwd: join(root, 'apps', 'api') },
  { name: 'worker', color: 33, argv: [tsx, 'src/dev.ts'], cwd: join(root, 'apps', 'worker') },
  { name: 'roll-web', color: 35, argv: [vite], cwd: join(root, 'apps', 'roll-web') },
  { name: 'twin', color: 32, argv: [vite], cwd: join(root, 'apps', 'twin') },
  { name: 'studio', color: 34, argv: [vite], cwd: join(root, 'apps', 'studio') },
];
if (process.argv.includes('--daemon')) {
  SERVERS.push({ name: 'firmware', color: 31, argv: [join(root, 'scripts', 'firmware-daemon.mjs')], cwd: root });
}
const picked = only ? SERVERS.filter((s) => only.includes(s.name)) : SERVERS;
if (picked.length === 0) {
  console.error(`[dev-all] --only matched nothing. Known: ${SERVERS.map((s) => s.name).join(', ')}`);
  process.exit(1);
}

function oneShot(command, label) {
  console.log(`[dev-all] ${label}`);
  const result = spawnSync(command, { cwd: root, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`[dev-all] ${label} failed (${String(result.status)}) — fix that first.`);
    process.exit(result.status ?? 1);
  }
}

// api and worker need postgres/redis/minio; skip the docker steps when
// neither was picked (pure front-end session).
if (picked.some((s) => s.name === 'api' || s.name === 'worker')) {
  oneShot('docker compose -f infra/docker-compose.dev.yml up -d', 'starting postgres/redis/minio');
  oneShot('npm run db:migrate -w @kino/api', 'migrating database');
}

const children = [];
let shuttingDown = false;

function prefixPipe(stream, name, color) {
  let carry = '';
  stream.on('data', (chunk) => {
    carry += chunk.toString();
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
    }
  });
}

for (const server of picked) {
  const child = spawn(process.execPath, server.argv, { cwd: server.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  prefixPipe(child.stdout, server.name, server.color);
  prefixPipe(child.stderr, server.name, server.color);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`\x1b[${server.color}m[${server.name}]\x1b[0m exited (${String(code)})`);
  });
  children.push(child);
  console.log(`[dev-all] ${server.name} started (pid ${String(child.pid)})`);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[dev-all] stopping dev servers (docker services stay up)');
  for (const child of children) child.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
