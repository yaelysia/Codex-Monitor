import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import { dockWindowBounds, findSavedDockDisplay, interpolateDockBounds, normalizeDockOpacity,
  type SavedDock, type WorkArea } from '../src/shared/window-geometry';
import type { FloatingCompactSize, FloatingWindowState, SignalAppearance } from '../src/shared/types';

/** Hidden renderer can be released without affecting the resident tray monitor. */
export const HIDDEN_RENDERER_IDLE_MS = 60_000;
/** A bounded native resize, independent of the renderer's CSS transitions. */
export const DOCK_EXPAND_MS = 260;
export const DOCK_COLLAPSE_MS = 220;
const DOCK_FRAME_MS = 16;
/** Check native/renderer lifecycle cheaply, only while the user wants the dock visible. */
export const FLOAT_HEALTH_CHECK_MS = 30_000;
export const FLOAT_LOAD_TIMEOUT_MS = 25_000;
export const FLOAT_REPAIR_DELAY_MS = 1_500;
export const FLOAT_UNRESPONSIVE_GRACE_MS = 15_000;
export const MAX_AUTO_FLOAT_REPAIRS = 3;
const FLOAT_REPAIR_WINDOW_MS = 10 * 60_000;
export class FloatingWindowController {
  private win: BrowserWindow | null = null;
  private dock: SavedDock;
  private snapping = false;
  private quitting = false;
  private idleDestroy: ReturnType<typeof setTimeout> | null = null;
  private motion: FloatingWindowState['motion'] = null;
  private motionTick: ReturnType<typeof setInterval> | null = null;
  private snapRelease: ReturnType<typeof setTimeout> | null = null;
  private healthTick: ReturnType<typeof setInterval> | null = null;
  private repairTick: ReturnType<typeof setTimeout> | null = null;
  private loadDeadline: ReturnType<typeof setTimeout> | null = null;
  private unresponsiveDeadline: ReturnType<typeof setTimeout> | null = null;
  private rendererReady = false;
  private rendererBroken = false;
  private autoRepairs: number[] = [];

  private stopMotion(): void {
    if (this.motionTick) clearInterval(this.motionTick);
    this.motionTick = null;
    this.motion = null;
  }

  /** Restart from the actual HWND bounds when a user reverses direction mid-animation. */
  private animateTo(target: Electron.Rectangle, direction: 'expanding' | 'collapsing'): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const from = win.getBounds();
    this.stopMotion();
    if (from.x === target.x && from.y === target.y &&
        from.width === target.width && from.height === target.height) {
      this.place(target);
      return;
    }
    this.motion = direction;
    const duration = direction === 'expanding' ? DOCK_EXPAND_MS : DOCK_COLLAPSE_MS;
    const started = Date.now();
    this.motionTick = setInterval(() => {
      if (this.win !== win || win.isDestroyed() || !win.isVisible()) {
        this.stopMotion();
        return;
      }
      const progress = Math.min(1, (Date.now() - started) / duration);
      this.place(interpolateDockBounds(from, target, progress));
      if (progress >= 1) {
        this.stopMotion();
        // Release the renderer's transition phase only after the native HWND
        // has reached its final bounds; notify once, not once per frame.
        this.onState(this.state());
      }
    }, DOCK_FRAME_MS);
    this.motionTick.unref?.();
  }

  private cancelRepair(): void {
    if (this.repairTick) clearTimeout(this.repairTick);
    this.repairTick = null;
  }

  private cancelLoadDeadline(): void {
    if (this.loadDeadline) clearTimeout(this.loadDeadline);
    this.loadDeadline = null;
  }

  private cancelUnresponsiveDeadline(): void {
    if (this.unresponsiveDeadline) clearTimeout(this.unresponsiveDeadline);
    this.unresponsiveDeadline = null;
  }

  private stopHealth(): void {
    if (this.healthTick) clearInterval(this.healthTick);
    this.healthTick = null;
  }

  private ensureHealth(): void {
    if (!this.dock.visible || this.quitting || this.healthTick) return;
    this.healthTick = setInterval(() => this.checkHealth(), FLOAT_HEALTH_CHECK_MS);
    this.healthTick.unref?.();
  }

  /** A BrowserWindow may still exist after its renderer has crashed.
   * Never regard isVisible() alone as proof it can draw the rail.
   */
  private checkHealth(): void {
    if (this.quitting || !this.dock.visible) return;
    const win = this.win;
    if (!win || win.isDestroyed() || win.webContents.isDestroyed() ||
        !win.isVisible() || this.rendererBroken) {
      this.scheduleRepair('window-or-renderer-unavailable');
      return;
    }
    // DWM / display transitions can clear the native topmost flag without
    // destroying the renderer. Restore it, without taking keyboard focus.
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'floating');
    const bounds = win.getBounds();
    const onScreen = screen.getAllDisplays().some(display => {
      const area = display.workArea;
      return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
        bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    });
    if (!onScreen && !this.snapping && !this.motion) this.reposition();
  }

  /** Restrict automatic rebuilds to three within ten minutes; a broken
   * Chromium/WebContents or a temporarily unavailable GPU must not cause a
   * restart storm. A deliberate tray repair remains available at any time.
   */
  private scheduleRepair(reason: string): void {
    if (this.quitting || !this.dock.visible || this.repairTick) return;
    this.repairTick = setTimeout(() => {
      this.repairTick = null;
      if (this.quitting || !this.dock.visible) return;
      const win = this.win;
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed() &&
          win.isVisible() && !this.rendererBroken) return;
      const now = Date.now();
      this.autoRepairs = this.autoRepairs.filter(at => now - at < FLOAT_REPAIR_WINDOW_MS);
      if (this.autoRepairs.length >= MAX_AUTO_FLOAT_REPAIRS) {
        console.warn('[Codex Monitor] Floating window repair limit reached; use the tray repair action');
        return;
      }
      this.autoRepairs.push(now);
      console.warn('[Codex Monitor] Rebuilding unavailable floating renderer:', reason);
      this.rebuildAndShow();
    }, FLOAT_REPAIR_DELAY_MS);
    this.repairTick.unref?.();
  }

  private markRendererBroken(win: BrowserWindow, reason: string): void {
    if (this.quitting || this.win !== win) return;
    this.rendererBroken = true;
    this.rendererReady = false;
    this.cancelLoadDeadline();
    this.scheduleRepair(reason);
  }

  private loaded(win: BrowserWindow): void {
    if (this.win !== win || win.isDestroyed()) return;
    this.rendererReady = true;
    this.rendererBroken = false;
    this.cancelLoadDeadline();
    this.cancelRepair();
  }

  /** Destroy and replace the native HWND, not merely show a still-crashed
   * WebContents. Retain the saved side/Y/size/opacity and remain unfocused.
   */
  private rebuildAndShow(): void {
    if (this.quitting || !this.dock.visible) return;
    const old = this.win;
    this.win = null; // Old 'closed' events cannot mutate the replacement.
    this.stopMotion();
    this.cancelIdleDestroy();
    this.cancelLoadDeadline();
    this.cancelUnresponsiveDeadline();
    this.rendererBroken = false;
    this.rendererReady = false;
    this.dock.expanded = false;
    if (old && !old.isDestroyed()) old.destroy();
    this.create();
    this.win!.showInactive();
    this.win!.setAlwaysOnTop(true, 'floating');
    this.ensureHealth();
    this.persist();
  }

  /** Explicit recovery even if Windows still reports a visible but blank
   * layered window. Also works if the user previously hid the rail.
   */
  repair(): FloatingWindowState {
    if (this.quitting) return this.state();
    this.cancelRepair();
    this.autoRepairs = [];
    this.dock.visible = true;
    this.rebuildAndShow();
    return this.state();
  }

  /** Resume/display-change reconciliation without waking a deliberately
   * hidden dock or bringing the floating rail into the foreground.
   */
  resume(): void {
    if (this.quitting || !this.dock.visible) return;
    this.reposition();
    const win = this.win;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.isVisible())
      win.setAlwaysOnTop(true, 'floating');
    this.checkHealth();
  }

  private cancelIdleDestroy(): void {
    if (this.idleDestroy) clearTimeout(this.idleDestroy);
    this.idleDestroy = null;
  }

  constructor(private readonly onState: (state: FloatingWindowState) => void,
    private readonly onHidden: () => void,
    initial: SavedDock,
    private readonly onPersist: (dock: SavedDock) => void) {
    this.dock = { ...initial };
  }

  state(): FloatingWindowState {
    return { visible: this.win && !this.win.isDestroyed() ? this.win.isVisible() : false,
      expanded: this.dock.expanded,
      side: this.dock.side, opacity: this.dock.opacity,
      appearance: this.dock.appearance ?? 'moonsea', compactSize: this.dock.compactSize ?? 'micro',
      motion: this.motion };
  }

  get browserWindow(): BrowserWindow | null { return this.win; }

  show(): FloatingWindowState {
    if (this.quitting) return this.state();
    this.cancelIdleDestroy();
    this.cancelRepair();
    this.stopMotion();
    this.dock.visible = true;
    // A dead renderer can leave a native HWND that still claims to be
    // visible; do not reuse it when the user requests the rail again.
    this.dock.expanded = false;
    if (!this.win || this.win.isDestroyed() || this.win.webContents.isDestroyed() ||
        this.rendererBroken) {
      this.rebuildAndShow();
    } else {
      this.place(this.bounds(this.display()));
      this.win.showInactive();
      this.win.setAlwaysOnTop(true, 'floating');
      this.ensureHealth();
      this.persist();
    }
    return this.state();
  }

  hide(): FloatingWindowState {
    this.cancelRepair();
    this.stopHealth();
    this.cancelUnresponsiveDeadline();
    this.stopMotion();
    this.win?.hide();
    this.dock.visible = false;
    this.persist();
    this.onHidden();
    this.cancelIdleDestroy();
    const captured = this.win;
    if (captured && !captured.isDestroyed()) {
      this.idleDestroy = setTimeout(() => {
        this.idleDestroy = null;
        // An old timer must not destroy a window that was shown again, or
        // replace a newly created rail after an Electron renderer crash.
        if (this.win === captured && !captured.isDestroyed() &&
            !captured.isVisible() && !this.dock.visible) captured.destroy();
      }, HIDDEN_RENDERER_IDLE_MS);
      this.idleDestroy.unref?.();
    }
    return this.state();
  }

  setVisible(visible: boolean): FloatingWindowState {
    return visible ? this.show() : this.hide();
  }

  setExpanded(expanded: boolean): FloatingWindowState {
    // A hidden rail must not construct a new renderer merely because a
    // delayed UI message changes its transient expanded preference.
    if (!this.win || this.win.isDestroyed()) {
      if (!this.dock.visible) {
        this.dock.expanded = expanded;
        this.persist();
        return this.state();
      }
      this.cancelIdleDestroy();
      this.create();
    }
    if (this.dock.expanded === expanded) return this.state();
    this.dock.expanded = expanded;
    const target = this.bounds(this.display());
    if (this.win!.isVisible()) {
      this.animateTo(target, expanded ? 'expanding' : 'collapsing');
    } else {
      this.stopMotion();
      this.place(target);
    }
    // The panel must receive focus so an outside click can still collapse it.
    if (expanded && this.win!.isVisible()) this.win!.focus();
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

  setAppearance(appearance: SignalAppearance): FloatingWindowState {
    this.dock.appearance = appearance;
    this.persist();
    return this.state();
  }

  setCompactSize(size: FloatingCompactSize): FloatingWindowState {
    this.dock.compactSize = size;
    if (this.win && !this.win.isDestroyed() && !this.dock.expanded) {
      this.stopMotion();
      this.place(this.bounds(this.display()));
    }
    this.persist();
    return this.state();
  }

  /** Recover a missing/off-screen dock even if the old display is unplugged. */
  resetPosition(): FloatingWindowState {
    this.stopMotion();
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
    this.stopMotion();
    const display = this.display();
    const previous = this.dock.offsetY;
    this.rememberDisplay(display);
    if (this.win && !this.win.isDestroyed()) this.place(this.bounds(display));
    if (previous !== this.dock.offsetY || this.win) this.persist();
  }

  allowQuit(): void {
    this.quitting = true;
    this.cancelRepair();
    this.stopHealth();
    this.cancelUnresponsiveDeadline();
    this.cancelLoadDeadline();
    this.stopMotion();
    this.cancelIdleDestroy();
    if (this.snapRelease) clearTimeout(this.snapRelease);
  }

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
    // Keep the rail's saved Y, not the panel's shorter permissible range.
    // The expanded panel clamps visually; collapse returns to the rail's
    // original Y rather than unexpectedly migrating up the display.
    const collapsed = dockWindowBounds({ ...this.dock, expanded: false },
      { ...display.workArea, id: display.id });
    this.dock.offsetY = Math.max(0, Math.min(this.dock.offsetY,
      Math.max(0, display.workArea.height - collapsed.height)));
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
    this.rendererReady = false;
    this.rendererBroken = false;
    this.cancelLoadDeadline();
    this.loadDeadline = setTimeout(() => {
      this.loadDeadline = null;
      if (this.win === win && !this.rendererReady)
        this.markRendererBroken(win, 'load-timeout');
    }, FLOAT_LOAD_TIMEOUT_MS);
    this.loadDeadline.unref?.();
    win.setOpacity(this.dock.opacity);
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason !== 'clean-exit') this.markRendererBroken(win, 'renderer-gone');
    });
    win.webContents.on('did-finish-load', () => this.loaded(win));
    win.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) this.markRendererBroken(win, 'load-failed');
    });
    win.on('unresponsive', () => {
      this.cancelUnresponsiveDeadline();
      this.unresponsiveDeadline = setTimeout(() => {
        this.unresponsiveDeadline = null;
        if (this.win === win && !win.isDestroyed()) this.markRendererBroken(win, 'unresponsive');
      }, FLOAT_UNRESPONSIVE_GRACE_MS);
      this.unresponsiveDeadline.unref?.();
    });
    win.on('responsive', () => this.cancelUnresponsiveDeadline());
    win.on('moved', () => { if (!this.snapping) this.snapToDisplayEdge(); });
    win.on('blur', () => {
      // A click outside this BrowserWindow removes focus. The rail remains
      // physically anchored, even while the larger panel contracts.
      if (!this.quitting && this.win === win && !win.isDestroyed() &&
          win.isVisible() && this.dock.expanded) this.setExpanded(false);
    });
    win.on('close', event => {
      if (this.quitting) return;
      event.preventDefault();
      this.hide();
    });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      this.rendererReady = false;
      this.cancelLoadDeadline();
      this.cancelUnresponsiveDeadline();
      this.stopMotion();
      if (this.snapRelease) clearTimeout(this.snapRelease);
      this.snapRelease = null;
      this.cancelIdleDestroy();
      this.onState(this.state());
      if (!this.quitting && this.dock.visible) this.scheduleRepair('window-closed');
    });
    const rendererURL = process.env.ELECTRON_RENDERER_URL;
    const load = rendererURL
      ? win.loadURL(rendererURL.replace(/\/$/, '') + '/floating.html')
      : win.loadFile(path.join(__dirname, '../renderer/floating.html'));
    void load.then(() => this.loaded(win))
      .catch(() => this.markRendererBroken(win, 'load-rejected'));
  }

  private place(bounds: Electron.Rectangle): void {
    if (!this.win || this.win.isDestroyed()) return;
    const before = this.win.getBounds();
    if (before.x === bounds.x && before.y === bounds.y &&
        before.width === bounds.width && before.height === bounds.height) return;
    this.snapping = true;
    this.win.setBounds(bounds);
    // The last delayed native moved event may arrive after setBounds returns.
    // One debounced release avoids dozens of overlapping snap timers.
    if (this.snapRelease) clearTimeout(this.snapRelease);
    this.snapRelease = setTimeout(() => {
      this.snapRelease = null;
      this.snapping = false;
    }, 150);
    this.snapRelease.unref?.();
  }

  private snapToDisplayEdge(): void {
    if (!this.win || this.win.isDestroyed() || this.motion) return;
    const before = this.win.getBounds();
    const display = screen.getDisplayMatching(before);
    const area = display.workArea;
    this.dock.side = before.x + before.width / 2 < area.x + area.width / 2 ? 'left' : 'right';
    this.rememberDisplay(display);
    this.dock.offsetY = Math.min(Math.max(0, before.y - area.y), Math.max(0, area.height - before.height));
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
