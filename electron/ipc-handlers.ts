import { app, clipboard, ipcMain } from 'electron';
import type { ResidentOptions } from '../src/shared/types';
import type { ResidentStore } from './resident-store';
import type { Settings } from '../src/shared/types';
import { readSettings, writeSettings } from './config';
import { listWslDistros } from './collector';
import { readRecentReply } from './reply-preview';
import type { FloatingWindowController } from './floating';
import type { MainWindowController } from './main-window';
import type { MonitorService } from './monitor-service';

export function registerIpcHandlers(monitor: MonitorService,
  floating: FloatingWindowController, main: MainWindowController,
  resident: ResidentStore, onPreferencesChanged: () => void): void {
  const supported = process.platform === 'win32' && app.isPackaged;
  const options = (): ResidentOptions => ({
    ...resident.snapshot().preferences,
    startupSupported: supported,
  });
  ipcMain.handle('resident:get', () => options());
  ipcMain.handle('resident:set', (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid resident options');
    const obj = raw as Record<string, unknown>;
    if (typeof obj.keepRunningOnClose !== 'boolean' || typeof obj.launchAtLogin !== 'boolean') {
      throw new Error('Resident preferences must be booleans');
    }
    if (obj.launchAtLogin && !supported) throw new Error('Start with Windows is available only in packaged Windows builds');
    if (supported) {
      app.setLoginItemSettings({
        openAtLogin: obj.launchAtLogin,
        path: process.execPath,
        args: ['--background'],
      });
    }
    resident.updatePreferences({
      keepRunningOnClose: obj.keepRunningOnClose,
      launchAtLogin: obj.launchAtLogin,
    });
    onPreferencesChanged();
    return options();
  });
  ipcMain.handle('config:get', async () => ({
    settings: await readSettings(), distros: await listWslDistros(),
  }));
  ipcMain.handle('config:set', async (_event, settings: Settings) => {
    const saved = await writeSettings(settings);
    void monitor.refresh(true).catch(console.error);
    return { settings: saved, distros: await listWslDistros() };
  });
  ipcMain.handle('monitor:refresh', () => monitor.refresh(true));
  ipcMain.handle('monitor:recent-reply', async (_event, key: unknown) => {
    if (typeof key !== 'string' || key.length > 300) throw new Error('Invalid session key');
    return readRecentReply(key, monitor.state().scan, await readSettings());
  });
  ipcMain.handle('monitor:get-state', () => monitor.state());
  ipcMain.handle('monitor:ack-alert', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length > 1024) throw new Error('Invalid alert id');
    return monitor.acknowledge(id);
  });
  ipcMain.handle('monitor:set-muted', (_event, muted: unknown) => {
    if (typeof muted !== 'boolean') throw new Error('Invalid mute flag');
    return monitor.setMuted(muted);
  });
  ipcMain.handle('floating:get-state', () => floating.state());
  ipcMain.handle('floating:set-visible', (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Invalid floating visibility');
    return floating.setVisible(visible);
  });
  ipcMain.handle('floating:set-expanded', (_event, expanded: unknown) => {
    if (typeof expanded !== 'boolean') throw new Error('Invalid floating expansion');
    return floating.setExpanded(expanded);
  });
  ipcMain.handle('floating:set-opacity', (_event, opacity: unknown) => {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) ||
      opacity < 0.4 || opacity > 1) {
      throw new Error('Floating opacity must be between 40% and 100%');
    }
    return floating.setOpacity(opacity);
  });
  ipcMain.handle('floating:reset-position', () => floating.resetPosition());
  ipcMain.handle('monitor:consume-focus-key', () => main.consumePendingKey());
  ipcMain.handle('monitor:show-main', (_event, sessionKey?: unknown) => {
    if (sessionKey != null && (typeof sessionKey !== 'string' || sessionKey.length > 300)) {
      throw new Error('Invalid session key');
    }
    const known = sessionKey == null || !!monitor.state().scan?.sources.some(
      source => source.sessions.some(session => session.key === sessionKey));
    main.show(known ? (sessionKey as string | undefined) : undefined);
  });
  ipcMain.handle('workspace:copy', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid workspace path');
    clipboard.writeText(text);
  });
}
