import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeDock, type SavedDock } from '../src/shared/window-geometry';
import type { FloatingWindowState } from '../src/shared/types';

const fake = vi.hoisted(() => ({
  windows: [] as any[],
  displays: [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 1600, height: 900 } },
  ],
}));

vi.mock('electron', () => {
  class FakeBrowserWindow {
    private listeners = new Map<string, Array<(...args: any[]) => void>>();
    bounds: { x: number; y: number; width: number; height: number };
    opacity = 1;
    visible = false;
    focused = false;
    focusCalls = 0;
    destroyed = false;
    readonly webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      loadFile: () => Promise.resolve(),
    };
    constructor(options: any) {
      this.bounds = {
        x: options.x, y: options.y, width: options.width, height: options.height,
      };
      fake.windows.push(this);
    }
    on(name: string, listener: (...args: any[]) => void) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    emit(name: string) { for (const listener of this.listeners.get(name) ?? []) listener(); }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; }
    setOpacity(value: number) { this.opacity = value; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    focus() { this.focused = true; this.focusCalls++; }
    isFocused() { return this.focused; }
    loseFocus() { this.focused = false; this.emit('blur'); }
    hide() { this.visible = false; this.focused = false; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
    setAlwaysOnTop() {}
    loadURL() { return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    drag(bounds: typeof this.bounds) { this.bounds = { ...bounds }; this.emit('moved'); }
  }
  const screen = {
    getAllDisplays: () => fake.displays,
    getPrimaryDisplay: () => fake.displays[0],
    getDisplayMatching: (bounds: { x: number; width: number }) =>
      fake.displays.find(d => bounds.x + bounds.width / 2 >= d.workArea.x &&
        bounds.x + bounds.width / 2 < d.workArea.x + d.workArea.width) ?? fake.displays[0],
  };
  return { BrowserWindow: FakeBrowserWindow, screen };
});

import { FloatingWindowController, HIDDEN_RENDERER_IDLE_MS, DOCK_EXPAND_MS, DOCK_COLLAPSE_MS } from '../electron/floating';

const INITIAL = normalizeDock({
  side: 'left', displayId: 2, displayX: 1920, displayY: 0,
  offsetY: 430, visible: true, expanded: false, opacity: 0.7,
});
beforeEach(() => {
  vi.useFakeTimers();
  fake.windows.length = 0;
  fake.displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 1600, height: 900 } },
  ];
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('floating window native opacity and position memory', () => {
  it('restores persisted monitor/edge/Y/opacity, live-updates opacity, and keeps it while hidden', async () => {
    const snapshots: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, INITIAL, value => snapshots.push(value));
    controller.show();
    expect(fake.windows).toHaveLength(1);
    const win = fake.windows[0]!;
    expect(win.bounds).toEqual({ x: 1920, y: 430, width: 38, height: 78 });
    expect(win.opacity).toBe(0.7);
    controller.setOpacity(0.55);
    expect(win.opacity).toBe(0.55);
    controller.setExpanded(true);
    expect(win.focusCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS + 20);
    expect(win.bounds.width).toBe(438);
    expect(win.opacity).toBe(0.55);
    controller.hide();
    controller.setOpacity(0.85);
    expect(controller.state()).toMatchObject({ visible: false, opacity: 0.85, expanded: true });
    controller.show();
    expect(fake.windows).toHaveLength(1); // No extra renderer on show.
    expect(controller.state().expanded).toBe(false); // Restored dock starts collapsed.
    expect(win.bounds.width).toBe(38);
    expect(win.opacity).toBe(0.85);
    expect(snapshots.at(-1)).toMatchObject({
      displayId: 2, side: 'left', offsetY: 430, opacity: 0.85,
    });
    const restored = new FloatingWindowController(
      () => undefined, () => undefined, snapshots.at(-1)!, () => undefined);
    restored.show();
    expect(fake.windows[1]?.opacity).toBe(0.85);
    expect(fake.windows[1]?.bounds).toMatchObject({ x: 1920, y: 430, width: 38 });
  });

  it('captures a cross-monitor drag and remembers the new location after restart', () => {
    const snapshots: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, normalizeDock({}), value => snapshots.push(value));
    controller.show();
    const win = fake.windows[0]!;
    win.drag({ x: 1920 + 1600 - 38 - 120, y: 530, width: 38, height: 78 });
    expect(controller.state().side).toBe('right');
    expect(win.bounds).toMatchObject({ x: 3482, y: 530 });
    expect(snapshots.at(-1)).toMatchObject({
      displayId: 2, displayX: 1920, side: 'right', offsetY: 530,
    });
    const restored = new FloatingWindowController(
      () => undefined, () => undefined, snapshots.at(-1)!, () => undefined);
    restored.show();
    expect(fake.windows[1]!.bounds).toEqual({ x: 3482, y: 530, width: 38, height: 78 });
  });

  it('recovers original display location when Windows changes its ID, then falls back if unplugged', () => {
    fake.displays[1]!.id = 200;
    const states: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, INITIAL, data => states.push(data));
    controller.show();
    expect(fake.windows[0]!.bounds.x).toBe(1920);
    expect(states.at(-1)?.displayId).toBe(200);
    fake.displays.pop();
    controller.reposition();
    expect(fake.windows[0]!.bounds.x).toBe(0);
    expect(states.at(-1)).toMatchObject({ displayId: 1, displayX: 0, offsetY: 430 });
    controller.resetPosition();
    expect(fake.windows[0]!.bounds).toMatchObject({ x: 1882, y: 92 });
    expect(states.at(-1)).toMatchObject({ opacity: 0.7, side: 'right', offsetY: 92 });
  });
});

describe('floating panel blur-to-collapse behavior', () => {
  it('expands with focus and collapses after clicking another window', async () => {
    const persisted: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, INITIAL, dock => persisted.push(dock));
    controller.show();
    const win = fake.windows[0]!;
    const closedBounds = { ...win.bounds };
    controller.setExpanded(true);
    expect(controller.state().expanded).toBe(true);
    expect(win.focused).toBe(true);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS + 20);
    expect(win.bounds.width).toBe(438);
    win.loseFocus();
    expect(controller.state()).toMatchObject({ visible: true, expanded: false });
    await vi.advanceTimersByTimeAsync(DOCK_COLLAPSE_MS + 20);
    expect(win.bounds).toEqual(closedBounds);
    expect(persisted.at(-1)?.expanded).toBe(false);
  });

  it('does not collapse while still focused, and does not steal focus when collapsed', async () => {
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, INITIAL, () => undefined);
    controller.show();
    const win = fake.windows[0]!;
    controller.setExpanded(true);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS + 20);
    expect(win.focusCalls).toBe(1);
    win.emit('moved');
    expect(controller.state().expanded).toBe(true);
    controller.setExpanded(false);
    await vi.advanceTimersByTimeAsync(DOCK_COLLAPSE_MS + 20);
    expect(win.focusCalls).toBe(1);
    win.loseFocus();
    expect(controller.state()).toMatchObject({ visible: true, expanded: false });
    controller.setExpanded(true);
    expect(win.focusCalls).toBe(2);
  });

  it('ignores blur when hidden; next show starts with collapsed rail', () => {
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, INITIAL, () => undefined);
    controller.show();
    const win = fake.windows[0]!;
    controller.setExpanded(true);
    controller.hide();
    win.loseFocus();
    expect(controller.state()).toMatchObject({ visible: false, expanded: true });
    controller.show();
    expect(controller.state()).toMatchObject({ visible: true, expanded: false });
    expect(win.bounds.width).toBe(38);
  });

  it('restores old persisted expanded=true docks as collapsed without focusing user desktop', () => {
    const saved = normalizeDock({ ...INITIAL, expanded: true, visible: true });
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, saved, () => undefined);
    controller.show();
    expect(controller.state()).toMatchObject({ visible: true, expanded: false });
    expect(fake.windows[0]!.focusCalls).toBe(0);
    expect(fake.windows[0]!.bounds.width).toBe(38);
  });
});

// Idle destroy is deliberately delayed: brief hide/show cycles reuse the
// original renderer; only a truly hidden rail releases its GPU/renderer state.
describe('hidden floating renderer lifecycle', () => {
  it('releases hidden window memory after one idle minute and rebuilds on show', async () => {
    vi.useFakeTimers();
    try {
      const snapshots: SavedDock[] = [];
      const controller = new FloatingWindowController(
        () => undefined, () => undefined, INITIAL, x => snapshots.push(x));
      controller.show();
      const first = fake.windows[0]!;
      controller.hide();
      await vi.advanceTimersByTimeAsync(HIDDEN_RENDERER_IDLE_MS - 1);
      expect(first.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.destroyed).toBe(true);
      expect(controller.state().visible).toBe(false);
      controller.setOpacity(0.53);
      controller.show();
      expect(fake.windows).toHaveLength(2);
      expect(fake.windows[1]?.opacity).toBe(0.53);
      expect(fake.windows[1]?.bounds.x).toBe(1920);
      expect(snapshots.at(-1)?.visible).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('cancels scheduled renderer disposal if shown again before expiration', async () => {
    vi.useFakeTimers();
    try {
      const controller = new FloatingWindowController(
        () => undefined, () => undefined, INITIAL, () => undefined);
      controller.show();
      const win = fake.windows[0]!;
      controller.hide();
      await vi.advanceTimersByTimeAsync(HIDDEN_RENDERER_IDLE_MS / 2);
      controller.show();
      await vi.advanceTimersByTimeAsync(HIDDEN_RENDERER_IDLE_MS + 1);
      expect(win.destroyed).toBe(false);
      expect(fake.windows).toHaveLength(1);
      controller.hide();
      await vi.advanceTimersByTimeAsync(HIDDEN_RENDERER_IDLE_MS);
      expect(win.destroyed).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('does not create a hidden renderer for an expanded-state preference', async () => {
    vi.useFakeTimers();
    try {
      const controller = new FloatingWindowController(
        () => undefined, () => undefined, INITIAL, () => undefined);
      controller.show();
      controller.hide();
      await vi.advanceTimersByTimeAsync(HIDDEN_RENDERER_IDLE_MS);
      controller.setExpanded(true);
      expect(fake.windows).toHaveLength(1);
      expect(controller.state().expanded).toBe(true);
      controller.show();
      expect(controller.state().expanded).toBe(false);
      expect(fake.windows).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});


describe('signal studio native compact rail', () => {
  it('switches micro and compact sizes without retaining an invisible window hit area', async () => {
    const captured: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, normalizeDock({ side: 'right' }),
      dock => captured.push(dock));
    controller.show();
    const win = fake.windows[0]!;
    expect(win.bounds).toMatchObject({ width: 38, height: 78 });
    controller.setCompactSize('compact');
    expect(win.bounds).toMatchObject({ width: 42, height: 120 });
    expect(controller.state().compactSize).toBe('compact');

    controller.setAppearance('ember');
    expect(controller.state().appearance).toBe('ember');
    controller.setExpanded(true);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS + 20);
    expect(win.bounds).toMatchObject({ width: 438, height: 488 });
    controller.setExpanded(false);
    await vi.advanceTimersByTimeAsync(DOCK_COLLAPSE_MS + 20);
    expect(win.bounds).toMatchObject({ width: 42, height: 120 });

    controller.hide();
    controller.show();
    expect(win.bounds).toMatchObject({ width: 42, height: 120 });
    expect(fake.windows).toHaveLength(1);
    expect(captured.at(-1)).toMatchObject({ appearance: 'ember', compactSize: 'compact' });

    const restored = new FloatingWindowController(
      () => undefined, () => undefined, normalizeDock(captured.at(-1)), () => undefined);
    restored.show();
    expect(fake.windows[1]?.bounds).toMatchObject({ width: 42, height: 120 });
    expect(restored.state()).toMatchObject({ appearance: 'ember', compactSize: 'compact' });
  });
});


describe('native floating transition under rapid interaction', () => {
  it('anchors the right edge on every frame and reverses without snapping to either endpoint', async () => {
    const snapshots: FloatingWindowState[] = [];
    const controller = new FloatingWindowController(
      state => snapshots.push(state), () => undefined,
      normalizeDock({ side: 'right', displayId: 1, offsetY: 960 }), () => undefined);
    controller.show();
    const win = fake.windows[0]!;
    const rail = { ...win.bounds };
    expect(rail).toEqual({ x: 1882, y: 960, width: 38, height: 78 });
    controller.setExpanded(true);
    expect(controller.state().motion).toBe('expanding');
    // Native resizing starts from the visible size rather than jumping to 438x488.
    expect(win.bounds).toEqual(rail);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS / 2);
    const halfway = { ...win.bounds };
    expect(halfway.width).toBeGreaterThan(rail.width);
    expect(halfway.width).toBeLessThan(438);
    expect(halfway.x + halfway.width).toBe(1920);
    expect(halfway.y).toBeGreaterThanOrEqual(592);
    expect(halfway.y).toBeLessThan(960);
    // A delayed window-moved event from native resize must not be interpreted as drag.
    win.emit('moved');
    expect(controller.state()).toMatchObject({ side: 'right', expanded: true });
    controller.setExpanded(false);
    expect(controller.state().motion).toBe('collapsing');
    expect(win.bounds).toEqual(halfway);
    await vi.advanceTimersByTimeAsync(DOCK_COLLAPSE_MS / 2);
    expect(win.bounds.width).toBeLessThan(halfway.width);
    expect(win.bounds.x + win.bounds.width).toBe(1920);
    await vi.advanceTimersByTimeAsync(DOCK_COLLAPSE_MS + 20);
    expect(win.bounds).toEqual(rail);
    expect(controller.state().motion).toBeNull();
    expect(snapshots.some(s => s.motion === 'expanding')).toBe(true);
    expect(snapshots.some(s => s.motion === 'collapsing')).toBe(true);
    expect(snapshots.at(-1)?.motion).toBeNull();
  });

  it('keeps the left edge fixed through expansion and returns to the saved bottom position', async () => {
    const controller = new FloatingWindowController(
      () => undefined, () => undefined,
      normalizeDock({ side: 'left', displayId: 2, displayX: 1920, displayY: 0,
        offsetY: 850, compactSize: 'compact' }), () => undefined);
    controller.show();
    const win = fake.windows[0]!;
    const start = { ...win.bounds };
    expect(start).toEqual({ x: 1920, y: 780, width: 42, height: 120 });
    controller.setExpanded(true);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS / 2);
    expect(win.bounds.x).toBe(1920);
    expect(win.bounds.width).toBeGreaterThan(42);
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS + 20);
    expect(win.bounds).toEqual({ x: 1920, y: 412, width: 438, height: 488 });
    controller.setExpanded(false);
    await vi.advanceTimersByTimeAsync(DOCK_COLLAPSE_MS + 20);
    expect(win.bounds).toEqual(start);
  });

  it('cancels a pending native transition on hide, then shows only the compact hit area', async () => {
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, normalizeDock({ side: 'right' }), () => undefined);
    controller.show();
    const win = fake.windows[0]!;
    controller.setExpanded(true);
    await vi.advanceTimersByTimeAsync(60);
    expect(win.bounds.width).toBeGreaterThan(38);
    controller.hide();
    const stopped = { ...win.bounds };
    await vi.advanceTimersByTimeAsync(DOCK_EXPAND_MS + 30);
    expect(win.bounds).toEqual(stopped);
    controller.show();
    expect(win.bounds).toMatchObject({ width: 38, height: 78 });
    expect(controller.state()).toMatchObject({ expanded: false, motion: null });
    expect(fake.windows).toHaveLength(1);
  });
});
