import path from 'node:path';
import { BrowserWindow } from 'electron';

/** Created only on demand; closing releases its renderer, not the monitor. */
export class DiagnosticsWindowController {
  private win: BrowserWindow | null = null;
  window(): BrowserWindow | null { return this.win && !this.win.isDestroyed() ? this.win : null; }
  show(): void {
    let win = this.window();
    if (!win) {
      win = new BrowserWindow({ width: 1000, height: 760, minWidth: 720, minHeight: 480,
        title: 'Codex Monitor · 诊断中心', backgroundColor: '#111827', autoHideMenuBar: true,
        show: false, webPreferences: { preload: path.join(__dirname, '../preload/index.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true } });
      this.win = win;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.once('ready-to-show', () => { if (!win!.isDestroyed()) win!.show(); });
      win.on('closed', () => { if (this.win === win) this.win = null; });
      const load = process.env.ELECTRON_RENDERER_URL
        ? win.loadURL(new URL('diagnostics.html', process.env.ELECTRON_RENDERER_URL + '/').href)
        : win.loadFile(path.join(__dirname, '../renderer/diagnostics.html'));
      void load.catch(() => { if (win && !win.isDestroyed()) win.close(); });
    } else {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
    }
  }
  destroy(): void { this.window()?.destroy(); this.win = null; }
}
