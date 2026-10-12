import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { dockWindowBounds, findSavedDockDisplay, normalizeDockOpacity,
  type SavedDock, type WorkArea } from '../src/shared/window-geometry';
import type { FloatingWindowState } from '../src/shared/types';

const HEIGHT = 276;
export class FloatingWindowController {
  private win: BrowserWindow | null = null;
  private dock: SavedDock;
  private snapping = false;
  private quitting = false;

  constructor(private readonly onState: (state: FloatingWindowState) => void,
    private readonly onHidden: () => void,
    initial: SavedDock,
    private readonly onPersist: (dock: SavedDock) => void) {
    this.dock = { ...initial };
  }

  state(): FloatingWindowState {
    return { visible: this.win?.isVisible() ?? false, expanded: this.dock.expanded,
      side: this.dock.side, opacity: this.dock.opacity };
  }

  get browserWindow(): BrowserWindow | null { return this.win; }

  show(): FloatingWindowState {
    if (!this.win || this.win.isDestroyed()) this.create();
    this.dock.visible = true;
    this.win!.showInactive();
    this.persist();
    return this.state();
  }

  hide(): FloatingWindowState {
    this.win?.hide();
    this.dock.visible = false;
    this.persist();
    this.onHidden();
    return this.state();
  }

  setVisible(visible: boolean): FloatingWindowState {
    return visible ? this.show() : this.hide();
  }

  setExpanded(expanded: boolean): FloatingWindowState {
    if (!this.win || this.win.isDestroyed()) this.create();
    this.dock.expanded = expanded;
    this.place(this.bounds(this.display()));
    this.persist();
    return this.state();
  }

  /** Apply without creating or showing the floating window. Values persist when hidden. */
  setOpacity(opacity: number): FloatingWindowState {
    this.dock.opacity = normalizeDockOpacity(opacity);
    if (this.win && !this.win.isDestroyed()) this.win.setOpacity(this.dock.opacity);
    this.persist();
    return this.state();
  }

  /** Recover a missing/off-screen dock even if the old display is unplugged. */
  resetPosition(): FloatingWindowState {
    const primary = screen.getPrimaryDisplay();
    this.dock.side = 'right';
    this.dock.offsetY = 92;
    this.rememberDisplay(primary);
    if (this.win && !this.win.isDestroyed()) this.place(this.bounds(primary));
    this.persist();
    return this.state();
  }

  /** Re-clamp after a monitor is disconnected or its workArea changes. */
  reposition(): void {
    const display = this.display();
    const previous = this.dock.offsetY;
    this.rememberDisplay(display);
    if (this.win && !this.win.isDestroyed()) this.place(this.bounds(display));
    if (previous !== this.dock.offsetY || this.win) this.persist();
  }

  allowQuit(): void { this.quitting = true; }

  private display(): Electron.Display {
    const displays = screen.getAllDisplays();
    const areas: WorkArea[] = displays.map(display => ({ ...display.workArea, id: display.id }));
    const saved = findSavedDockDisplay(this.dock, areas);
    return displays.find(display => display.id === saved?.id) ?? screen.getPrimaryDisplay();
  }

  private rememberDisplay(display: Electron.Display): void {
    this.dock.displayId = display.id;
    this.dock.displayX = display.workArea.x;
    this.dock.displayY = display.workArea.y;
    this.dock.offsetY = Math.max(0, Math.min(this.dock.offsetY,
      Math.max(0, display.workArea.height - HEIGHT)));
  }

  private bounds(display: Electron.Display): Electron.Rectangle {
    const area: WorkArea = { ...display.workArea, id: display.id };
    return dockWindowBounds(this.dock, area);
  }

  private create(): void {
    const display = this.display();
    this.rememberDisplay(display);
    const win = new BrowserWindow({
      ...this.bounds(display), frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false,
      alwaysOnTop: true, skipTaskbar: true, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      autoHideMenuBar: true, show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    this.win = win;
    win.setOpacity(this.dock.opacity);
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('moved', () => { if (!this.snapping) this.snapToDisplayEdge(); });
    win.on('close', event => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    win.on('closed', () => { this.win = null; this.onState(this.state()); });
    const rendererURL = process.env.ELECTRON_RENDERER_URL;
    if (rendererURL) void win.loadURL(rendererURL.replace(/\/$/, '') + '/floating.html');
    else void win.loadFile(path.join(__dirname, '../renderer/floating.html'));
  }

  private place(bounds: Electron.Rectangle): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.snapping = true;
    this.win.setBounds(bounds);
    setTimeout(() => { this.snapping = false; }, 150);
  }

  private snapToDisplayEdge(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const before = this.win.getBounds();
    const display = screen.getDisplayMatching(before);
    const area = display.workArea;
    this.dock.side = before.x + before.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
    this.rememberDisplay(display);
    this.dock.offsetY = Math.min(Math.max(0, before.y - area.y), Math.max(0, area.height - HEIGHT));
    const target = this.bounds(display);
    if (before.x !== target.x || before.y !== target.y || before.width !== target.width) {
      this.place(target);
    }
    this.persist();
  }

  private persist(): void {
    this.onPersist({ ...this.dock });
    this.onState(this.state());
  }
}
