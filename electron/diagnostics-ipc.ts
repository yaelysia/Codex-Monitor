import fs from 'node:fs/promises';
import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { MonitorService } from './monitor-service';
import type { DiagnosticsWindowController } from './diagnostics-window';

export function registerDiagnosticsIpc(monitor: MonitorService, center: DiagnosticsWindowController): void {
  const authorize = (event: IpcMainInvokeEvent) => {
    const win = center.window();
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw new Error('诊断接口仅供诊断中心使用');
    return win;
  };
  ipcMain.handle('diagnostics:get', event => { authorize(event); return monitor.diagnostics(); });
  ipcMain.handle('diagnostics:clear', event => { authorize(event); return monitor.clearDiagnostics(); });
  ipcMain.handle('diagnostics:native-get', event => { authorize(event); return monitor.nativeConnections(); });
  ipcMain.handle('diagnostics:native-set', (event, raw: unknown) => {
    authorize(event); return monitor.setNativeConnections(raw);
  });
  let exporting = false;
  ipcMain.handle('diagnostics:export', async event => {
    const win = authorize(event);
    if (exporting) return 'cancelled';
    exporting = true;
    try {
      // Capture only the redacted report. Display identities/config never enter the file.
      const report = monitor.diagnostics().report;
      const result = await dialog.showSaveDialog(win, {
        title: '导出脱敏诊断报告', defaultPath: 'codex-monitor-diagnostics.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return 'cancelled';
      await fs.writeFile(result.filePath, JSON.stringify(report, null, 2), { mode: 0o600 });
      return 'saved';
    } catch { throw new Error('诊断报告导出失败'); }
    finally { exporting = false; }
  });
}
