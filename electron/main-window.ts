import path from 'node:path';
import { BrowserWindow } from 'electron';

export class MainWindowController {
  private win: BrowserWindow | null = null;
  private pendingKey: string | null = null;

  constructor(private readonly onClosed: () => void) {}

  show(sessionKey?: string): void {
    let win = this.win;
    if (!win || win.isDestroyed()) {
      win = this.create();
      this.win = win;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (sessionKey) {
      this.pendingKey = sessionKey;
      const send = () => {
        if (win && !win.isDestroyed()) win.webContents.send('monitor:focus-session', sessionKey);
      };
      if (win.webContents.isLoadingMainFrame()) win.webContents.once('did-finish-load', send);
      else send();
    }
  }

  isOpen(): boolean { return !!this.win && !this.win.isDestroyed(); }

  /** A renderer can request an early focus action even if it missed its load-time IPC event. */
  consumePendingKey(): string | null {
    const key = this.pendingKey;
    this.pendingKey = null;
    return key;
  }

  private create(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1170, height: 780, minWidth: 820, minHeight: 500,
      backgroundColor: '#111117', autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', (_, details) =>
      console.error('Renderer exited:', details.reason));
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this.onClosed();
    });
    if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
    return win;
  }
}
