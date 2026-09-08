const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

app.setName('KINO Print');
if (process.platform === 'win32') app.setAppUserModelId('com.kino.print');

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const backendDir = () => isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'backend');
const dataDir = () => path.join(app.getPath('userData'), 'runtime');
const statePath = () => path.join(dataDir(), 'print-state.json');
const controlPath = () => path.join(dataDir(), 'print-control.json');
const logPath = () => path.join(dataDir(), 'print-worker.log');
const python = process.env.KINO_PRINT_PYTHON || 'C:/Python314/python.exe';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: '#c0c0c0',
    title: 'KINO Print',
    frame: false,
    icon: path.join(__dirname, '..', 'assets', 'kino-print.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (devServerUrl) mainWindow.loadURL(devServerUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function runBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(backendDir(), 'bridge.py'), ...args], { cwd: backendDir(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr || `Printer helper exited with code ${code}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Printer helper returned invalid data.')); }
      }
    });
  });
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const active = new Set(['connecting', 'heating', 'printing', 'paused', 'stopping']);
    if (active.has(state.status) && state.updated_at) {
      const age = Date.now() - new Date(state.updated_at).getTime();
      if (age > 10 * 60 * 1000) return { ...state, status: 'error', message: 'Print worker stopped updating. Check the printer and USB cable.' };
    }
    return state;
  } catch {
    return { status: 'idle', message: 'Ready', progress: 0 };
  }
}

ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open sliced G-code',
    properties: ['openFile'],
    filters: [{ name: 'G-code files', extensions: ['gcode', 'gco'] }, { name: 'All files', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('file:inspect', (_event, file) => runBridge(['inspect', '--file', file]));
ipcMain.handle('printer:ports', () => runBridge(['ports']));
ipcMain.handle('print:status', () => readState());
ipcMain.handle('print:start', (_event, request) => {
  const current = readState();
  if (['connecting', 'heating', 'printing', 'paused', 'stopping'].includes(current.status)) {
    throw new Error('A print is already active.');
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  atomicWrite(controlPath(), { action: 'none', at: Date.now() });
  const out = fs.openSync(logPath(), 'a');
  const args = [
    path.join(backendDir(), 'print_worker.py'),
    '--port', request.port,
    '--file', request.file,
    '--state', statePath(),
    '--control', controlPath(),
    '--nozzle-temp', String(request.nozzleTemp),
  ];
  if (request.antiOoze) args.push('--anti-ooze');
  const child = spawn(python, args, { cwd: backendDir(), detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  return { ok: true, pid: child.pid };
});
ipcMain.handle('print:control', (_event, action) => {
  if (!['pause', 'resume', 'stop'].includes(action)) throw new Error('Unsupported print control.');
  atomicWrite(controlPath(), { action, at: Date.now() });
  return { ok: true };
});
ipcMain.handle('print:emergency-cooldown', async () => {
  const current = readState();
  const result = await runBridge(['cooldown', '--port', current.port || '']);
  atomicWrite(statePath(), {
    ...current,
    status: 'stopped',
    phase: 'stopped',
    message: 'Print stopped. Heater targets confirmed at 0°C.',
    hotend_target: 0,
    bed_target: 0,
    hotend_power: 0,
    bed_power: 0,
    nozzle_interlock: 'locked',
    updated_at: new Date().toISOString(),
  });
  return result;
});
ipcMain.handle('print:acknowledge-power-off', () => {
  const current = readState();
  atomicWrite(statePath(), {
    ...current,
    status: 'stopped',
    phase: 'stopped',
    message: 'Printer powered off. USB print stopped safely.',
    hotend: null,
    hotend_target: 0,
    bed: null,
    bed_target: 0,
    hotend_power: 0,
    bed_power: 0,
    nozzle_interlock: 'locked',
    updated_at: new Date().toISOString(),
  });
  return { ok: true };
});
ipcMain.handle('print:show-log', async () => {
  fs.mkdirSync(dataDir(), { recursive: true });
  if (!fs.existsSync(logPath())) fs.writeFileSync(logPath(), 'No print log has been created yet.\n');
  return shell.openPath(logPath());
});
ipcMain.handle('help:guide', () => shell.openExternal('https://help.prusa3d.com/category/using-the-printer_202'));
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
