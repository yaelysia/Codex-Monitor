import { clipboard, ipcMain } from 'electron';
import type { Settings } from '../src/shared/types';
import { readSettings, writeSettings } from './config';
import { listWslDistros } from './collector';
import type { FloatingWindowController } from './floating';
import type { MainWindowController } from './main-window';
import type { MonitorService } from './monitor-service';

export function registerIpcHandlers(monitor: MonitorService,
  floating: FloatingWindowController, main: MainWindowController): void {
  ipcMain.handle('config:get', async () => ({
    settings: await readSettings(), distros: await listWslDistros(),
  }));
  ipcMain.handle('config:set', async (_event, settings: Settings) => {
    const saved = await writeSettings(settings);
    void monitor.refresh(true).catch(console.error);
    return { settings: saved, distros: await listWslDistros() };
  });
  ipcMain.handle('monitor:refresh', () => monitor.refresh(true));
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
