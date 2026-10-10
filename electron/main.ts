import path from 'node:path';
import { app, BrowserWindow, ipcMain, clipboard } from 'electron';
import type { Settings } from '../src/shared/types';
import { readSettings, writeSettings } from './config';
import { listWslDistros, refresh } from './collector';

// Windows can crash its Chromium GPU child during sandbox startup (Electron #51761).
// Opt-in workaround only: disabling the GPU sandbox weakens process isolation.
// Apply this before app.whenReady() so Chromium child processes see the switch.
if (process.platform === 'win32' && process.env.CODEX_MONITOR_DISABLE_GPU_SANDBOX === '1') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  console.warn('[Codex Monitor] GPU sandbox disabled by CODEX_MONITOR_DISABLE_GPU_SANDBOX=1');
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1150, height: 760, minWidth: 820, minHeight: 500,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', (_, details) => console.error('Renderer exited:', details.reason));
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  ipcMain.handle('config:get', async () => ({ settings: await readSettings(), distros: await listWslDistros() }));
  ipcMain.handle('config:set', async (_event, settings: Settings) => ({
    settings: await writeSettings(settings), distros: await listWslDistros(),
  }));
  ipcMain.handle('monitor:refresh', async () => refresh(await readSettings()));
  ipcMain.handle('workspace:copy', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid workspace path');
    clipboard.writeText(text);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((error) => { console.error('Unable to start Codex Monitor:', error); app.quit(); });

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
