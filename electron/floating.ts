import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import type { FloatingSide, FloatingWindowState } from '../src/shared/types';

const RAIL_WIDTH = 55;
const OPEN_WIDTH = 350;
const HEIGHT = 276;
const TOP_OFFSET = 92;

/** Frameless rail pinned to the nearest edge, expanding inward on demand. */
export class FloatingWindowController {
  private win: BrowserWindow | null = null;
  private side: FloatingSide = 'right';
  private expanded = false;
  private dockY: number | null = null;
  private snapping = false;
  private quitting = false;

  constructor(private readonly onState: (state: FloatingWindowState) => void,
    private readonly onHidden: () => void) {}

  state(): FloatingWindowState {
    return { visible: this.win?.isVisible() ?? false, expanded: this.expanded, side: this.side };
  }

  get browserWindow(): BrowserWindow | null { return this.win; }

  show(): FloatingWindowState {
    if (!this.win || this.win.isDestroyed()) this.create();
    this.win!.showInactive();
    this.notify();
    return this.state();
  }

  hide(): FloatingWindowState {
    this.win?.hide();
    this.notify();
    this.onHidden();
    return this.state();
  }

  setVisible(visible: boolean): FloatingWindowState {
    return visible ? this.show() : this.hide();
  }

  setExpanded(expanded: boolean): FloatingWindowState {
    if (!this.win || this.win.isDestroyed()) this.create();
    this.expanded = expanded;
    const bounds = this.win!.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    this.place(this.bounds(area));
    return this.state();
  }

  allowQuit(): void { this.quitting = true; }

  private create(): void {
    const area = screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({
      ...this.bounds(area),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    this.win = win;
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('moved', () => { if (!this.snapping) this.snapToDisplayEdge(); });
    win.on('close', event => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    win.on('closed', () => { this.win = null; this.notify(); });
    const rendererURL = process.env.ELECTRON_RENDERER_URL;
    if (rendererURL) void win.loadURL(rendererURL.replace(/\/$/, '') + '/floating.html');
    else void win.loadFile(path.join(__dirname, '../renderer/floating.html'));
  }

  private bounds(area: Electron.Rectangle): Electron.Rectangle {
    const width = this.expanded ? Math.min(OPEN_WIDTH, area.width) : RAIL_WIDTH;
    const x = this.side === 'right' ? area.x + area.width - width : area.x;
    const y = Math.min(Math.max(this.dockY ?? area.y + TOP_OFFSET, area.y),
      area.y + area.height - HEIGHT);
    return { x, y, width, height: HEIGHT };
  }

  private place(bounds: Electron.Rectangle): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.snapping = true;
    this.win.setBounds(bounds);
    setTimeout(() => { this.snapping = false; }, 150);
    this.notify();
  }

  private snapToDisplayEdge(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const before = this.win.getBounds();
    const area = screen.getDisplayMatching(before).workArea;
    this.side = before.x + before.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
    this.dockY = before.y;
    const after = this.bounds(area);
    if (before.x !== after.x || before.y !== after.y || before.width !== after.width) {
      this.place(after);
    } else this.notify();
  }

  private notify(): void { this.onState(this.state()); }
}
