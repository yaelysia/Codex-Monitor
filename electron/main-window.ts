import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { restoreMainBounds, type WorkArea } from '../src/shared/window-geometry';
import type { ResidentStore } from './resident-store';

export class MainWindowController {
  private win: BrowserWindow | null = null;
  private pendingKey: string | null = null;

  constructor(private readonly onClosed: () => void, private readonly store: ResidentStore) {}

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

  consumePendingKey(): string | null {
    const key = this.pendingKey;
    this.pendingKey = null;
    return key;
  }

  private create(): BrowserWindow {
    const primary = screen.getPrimaryDisplay().workArea;
    const fallback = {
      x: primary.x + Math.max(0, Math.floor((primary.width - 1170) / 2)),
      y: primary.y + Math.max(0, Math.floor((primary.height - 780) / 2)),
      width: Math.min(1170, primary.width), height: Math.min(780, primary.height),
    };
    const areas: WorkArea[] = screen.getAllDisplays().map(display => ({
      ...display.workArea, id: display.id,
    }));
    const bounds = restoreMainBounds(this.store.snapshot().mainBounds, areas, fallback);
    const win = new BrowserWindow({
      ...bounds, minWidth: 820, minHeight: 500,
      backgroundColor: '#111117', autoHideMenuBar: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    const saveBounds = () => {
      if (!win.isDestroyed() && !win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) {
        this.store.updateMainBounds(win.getNormalBounds());
      }
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
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
