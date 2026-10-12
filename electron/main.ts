import { app, BrowserWindow, screen } from 'electron';
import type { FloatingWindowState, MonitorState } from '../src/shared/types';
import { MainWindowController } from './main-window';
import { FloatingWindowController } from './floating';
import { MonitorService } from './monitor-service';
import { showDesktopAlert } from './desktop-notifications';
import { registerIpcHandlers } from './ipc-handlers';
import { ResidentStore } from './resident-store';
import { TrayController } from './tray';
import { AutoWindowTracker } from './window-tracking';
import { focusAndRead } from '../src/shared/focus-and-read';

if (process.platform === 'win32' && process.env.CODEX_MONITOR_DISABLE_GPU_SANDBOX === '1') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  console.warn('[Codex Monitor] GPU sandbox disabled by CODEX_MONITOR_DISABLE_GPU_SANDBOX=1');
}
if (process.platform === 'win32') app.setAppUserModelId('dev.yaelysia.codex-monitor');

// Only one resident monitor may own watchers and desktop notifications.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.quit();

let mainWindow: MainWindowController | null = null;
let floating: FloatingWindowController | null = null;
let monitor: MonitorService | null = null;
let tray: TrayController | null = null;
let resident: ResidentStore | null = null;
let windowTracker: AutoWindowTracker | null = null;

function broadcast(channel: string, state: MonitorState | FloatingWindowState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, state);
  }
  tray?.refresh();
}

if (firstInstance) {
  app.on('second-instance', () => mainWindow?.show());
  app.whenReady().then(() => {
    resident = new ResidentStore(app.getPath('userData'));
    const saved = resident.load();
    mainWindow = new MainWindowController(() => {
      if (!resident?.snapshot().preferences.keepRunningOnClose) app.quit();
    }, resident);
    floating = new FloatingWindowController(
      state => broadcast('floating:state', state),
      () => tray?.refresh(),
      saved.dock,
      state => resident?.updateDock(state),
    );
    windowTracker = new AutoWindowTracker();
    windowTracker.start();
    monitor = new MonitorService(
      state => broadcast('monitor:state', state),
      alert => showDesktopAlert(alert, key => {
        if (!monitor || !windowTracker) { mainWindow?.show(key); return; }
        void focusAndRead(key, monitor.state().alerts,
          () => windowTracker!.focusOriginalWindow(key),
          ids => monitor?.acknowledgeMany(ids)).then(result => {
          if (result.state !== 'focused') mainWindow?.show(key);
        }).catch(() => mainWindow?.show(key));
      }, id => { monitor?.acknowledge(id); }),
      snapshot => windowTracker?.observeScan(snapshot),
    );
    tray = new TrayController(mainWindow, floating, monitor, resident, () => app.quit());
    tray.start();
    registerIpcHandlers(monitor, floating, mainWindow, resident, () => tray?.refresh(), windowTracker);
    if (!process.argv.includes('--background')) mainWindow.show();
    if (saved.dock.visible) floating.show();
    monitor.start();
    screen.on('display-removed', () => floating?.reposition());
    screen.on('display-metrics-changed', () => floating?.reposition());
    app.on('activate', () => mainWindow?.show());
  }).catch(error => {
    console.error('Unable to start Codex Monitor:', error);
    app.quit();
  });
}

// The tray, not a hidden renderer window, owns the background lifetime.
app.on('window-all-closed', () => { /* intentional: fully quit from tray */ });
app.on('before-quit', () => {
  monitor?.stop();
  windowTracker?.stop();
  floating?.allowQuit();
  resident?.flush();
  tray?.destroy();
});
