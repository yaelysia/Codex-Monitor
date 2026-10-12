import { app, BrowserWindow } from 'electron';
import type { FloatingWindowState, MonitorState } from '../src/shared/types';
import { MainWindowController } from './main-window';
import { FloatingWindowController } from './floating';
import { MonitorService } from './monitor-service';
import { showDesktopAlert } from './desktop-notifications';
import { registerIpcHandlers } from './ipc-handlers';

// Opt-in workaround for the Windows GPU sandbox crash (Electron #51761).
if (process.platform === 'win32' && process.env.CODEX_MONITOR_DISABLE_GPU_SANDBOX === '1') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  console.warn('[Codex Monitor] GPU sandbox disabled by CODEX_MONITOR_DISABLE_GPU_SANDBOX=1');
}
if (process.platform === 'win32') app.setAppUserModelId('dev.yaelysia.codex-monitor');

let mainWindow: MainWindowController;
let floating: FloatingWindowController;
let monitor: MonitorService;

function broadcast(channel: string, state: MonitorState | FloatingWindowState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, state);
  }
}

app.whenReady().then(() => {
  mainWindow = new MainWindowController(() => {
    if (!floating?.state().visible) app.quit();
  });
  floating = new FloatingWindowController(
    state => broadcast('floating:state', state),
    () => { if (!mainWindow.isOpen()) app.quit(); },
  );
  monitor = new MonitorService(
    state => broadcast('monitor:state', state),
    alert => showDesktopAlert(alert, key => mainWindow.show(key)),
  );
  registerIpcHandlers(monitor, floating, mainWindow);
  mainWindow.show();
  floating.show();
  monitor.start();
  app.on('activate', () => { if (!mainWindow.isOpen()) mainWindow.show(); });
}).catch(error => { console.error('Unable to start Codex Monitor:', error); app.quit(); });

app.on('before-quit', () => {
  monitor?.stop();
  floating?.allowQuit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
