import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeDock, type SavedDock } from '../src/shared/window-geometry';

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
    hide() { this.visible = false; }
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

import { FloatingWindowController } from '../electron/floating';

const INITIAL = normalizeDock({
  side: 'left', displayId: 2, displayX: 1920, displayY: 0,
  offsetY: 430, visible: true, expanded: false, opacity: 0.7,
});
beforeEach(() => {
  fake.windows.length = 0;
  fake.displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 1600, height: 900 } },
  ];
});
afterEach(() => vi.restoreAllMocks());

describe('floating window native opacity and position memory', () => {
  it('restores persisted monitor/edge/Y/opacity, live-updates opacity, and keeps it while hidden', () => {
    const snapshots: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, INITIAL, value => snapshots.push(value));
    controller.show();
    expect(fake.windows).toHaveLength(1);
    const win = fake.windows[0]!;
    expect(win.bounds).toEqual({ x: 1920, y: 430, width: 55, height: 276 });
    expect(win.opacity).toBe(0.7);
    controller.setOpacity(0.55);
    expect(win.opacity).toBe(0.55);
    controller.setExpanded(true);
    expect(win.bounds.width).toBe(350);
    expect(win.opacity).toBe(0.55);
    controller.hide();
    controller.setOpacity(0.85);
    expect(controller.state()).toMatchObject({ visible: false, opacity: 0.85, expanded: true });
    controller.show();
    expect(fake.windows).toHaveLength(1); // No extra renderer on show.
    expect(win.opacity).toBe(0.85);
    expect(snapshots.at(-1)).toMatchObject({
      displayId: 2, side: 'left', offsetY: 430, opacity: 0.85,
    });
    const restored = new FloatingWindowController(
      () => undefined, () => undefined, snapshots.at(-1)!, () => undefined);
    restored.show();
    expect(fake.windows[1]?.opacity).toBe(0.85);
    expect(fake.windows[1]?.bounds).toMatchObject({ x: 1920, y: 430, width: 350 });
  });

  it('captures a cross-monitor drag and remembers the new location after restart', () => {
    const snapshots: SavedDock[] = [];
    const controller = new FloatingWindowController(
      () => undefined, () => undefined, normalizeDock({}), value => snapshots.push(value));
    controller.show();
    const win = fake.windows[0]!;
    win.drag({ x: 1920 + 1600 - 55 - 120, y: 530, width: 55, height: 276 });
    expect(controller.state().side).toBe('right');
    expect(win.bounds).toMatchObject({ x: 3465, y: 530 });
    expect(snapshots.at(-1)).toMatchObject({
      displayId: 2, displayX: 1920, side: 'right', offsetY: 530,
    });
    const restored = new FloatingWindowController(
      () => undefined, () => undefined, snapshots.at(-1)!, () => undefined);
    restored.show();
    expect(fake.windows[1]!.bounds).toEqual({ x: 3465, y: 530, width: 55, height: 276 });
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
    expect(fake.windows[0]!.bounds).toMatchObject({ x: 1865, y: 92 });
    expect(states.at(-1)).toMatchObject({ opacity: 0.7, side: 'right', offsetY: 92 });
  });
});
