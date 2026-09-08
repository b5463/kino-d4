import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, '..');
const workspaceRoot = path.resolve(appRoot, '..', '..');
const electronDist = path.join(workspaceRoot, 'node_modules', 'electron', 'dist');
const target = path.join(appRoot, 'release-final', 'KINO Print');
const resources = path.join(target, 'resources');
const packagedApp = path.join(resources, 'app');
const backend = path.join(resources, 'backend');

if (!target.startsWith(appRoot + path.sep)) throw new Error('Release path escaped the application directory.');
if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('Electron runtime is not installed. Run npm install first.');
if (!fs.existsSync(path.join(appRoot, 'dist', 'index.html'))) throw new Error('Production renderer is missing. Run npm run build first.');

fs.mkdirSync(target, { recursive: true });
fs.cpSync(electronDist, target, { recursive: true, force: true });
const sourceExe = path.join(target, 'electron.exe');
const targetExe = path.join(target, 'KINO Print.exe');
if (fs.existsSync(targetExe)) fs.rmSync(targetExe);
fs.renameSync(sourceExe, targetExe);

fs.mkdirSync(packagedApp, { recursive: true });
fs.mkdirSync(backend, { recursive: true });
for (const name of ['electron', 'dist', 'assets']) {
  fs.cpSync(path.join(appRoot, name), path.join(packagedApp, name), { recursive: true, force: true });
}
fs.copyFileSync(path.join(appRoot, 'package.json'), path.join(packagedApp, 'package.json'));
for (const name of ['print_worker.py', 'gcode_info.py', 'bridge.py']) {
  fs.copyFileSync(path.join(appRoot, name), path.join(backend, name));
}

console.log(`Packaged KINO Print: ${targetExe}`);
