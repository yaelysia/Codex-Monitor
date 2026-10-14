import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResidentStore, normalizeResident } from '../electron/resident-store';
import { dockWindowBounds, findSavedDockDisplay, interpolateDockBounds, normalizeDockOpacity,
  restoreMainBounds, type WorkArea } from '../src/shared/window-geometry';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map(p => fs.rm(p, { recursive: true, force: true })));
});

const area: WorkArea = { id: 100, x: -1920, y: 0, width: 1920, height: 1080 };
describe('resident window persistence and multi-display layout', () => {
  it('clamps off-screen main window bounds after monitor disconnect or DPI changes', () => {
    const fallback = { x: 100, y: 100, width: 1170, height: 780 };
    expect(restoreMainBounds({ x: -1900, y: 700, width: 1100, height: 700 }, [area], fallback))
      .toEqual({ x: -1900, y: 380, width: 1100, height: 700 });
    expect(restoreMainBounds({ x: 5000, y: 5000, width: 1000, height: 600 }, [area], fallback))
      .toEqual(fallback);
    expect(restoreMainBounds({ x: -1900, y: 50, width: 3000, height: 1300 }, [area], fallback))
      .toMatchObject({ width: 1920, height: 1080 });
  });

  it('remembers dock edge, display and vertical offset without going offscreen', () => {
    const dock = normalizeResident({ dock: { side: 'left', displayId: 100,
      expanded: true, offsetY: 2000, visible: false } }).dock;
    expect(dockWindowBounds(dock, area)).toEqual({ x: -1920, y: 592, width: 438, height: 488 });
    expect(dockWindowBounds({ ...dock, side: 'right', expanded: false }, area).x).toBe(-38);
  });

  it('uses safe defaults for corrupted data and restores user-selected preferences', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-resident-'));
    created.push(folder);
    const store = new ResidentStore(folder);
    expect(store.load().preferences).toEqual({ keepRunningOnClose: true, launchAtLogin: false });
    store.updatePreferences({ keepRunningOnClose: false, launchAtLogin: true });
    store.updateDock({ side: 'left', displayId: 100, offsetY: 220, expanded: false, visible: false, opacity: 1 });
    store.updateMainBounds({ x: 20, y: 60, width: 920, height: 640 });
    store.flush();
    const reopened = new ResidentStore(folder);
    const saved = reopened.load();
    expect(saved.preferences).toEqual({ keepRunningOnClose: false, launchAtLogin: true });
    expect(saved.dock.side).toBe('left');
    expect(saved.dock.visible).toBe(false);
    expect(saved.dock.opacity).toBe(1); // Existing files without opacity remain fully opaque.
    expect(saved.mainBounds?.width).toBe(920);
    expect(normalizeResident({ preferences: { launchAtLogin: 'yes', keepRunningOnClose: null },
      mainBounds: { width: NaN, height: 10, x: 0, y: 0 } }).mainBounds).toBeNull();
  });

  it('clamps malformed opacity and restores a chosen transparency level', async () => {
    expect(normalizeDockOpacity(undefined)).toBe(1);
    expect(normalizeDockOpacity(0)).toBe(0.4);
    expect(normalizeDockOpacity(1.5)).toBe(1);
    expect(normalizeDockOpacity(Number.NaN)).toBe(1);
    expect(normalizeDockOpacity(0.725)).toBe(0.73);
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-opacity-'));
    created.push(folder);
    const store = new ResidentStore(folder);
    store.load();
    store.updateDock({ ...store.snapshot().dock, side: 'left', displayId: 42,
      displayX: -2560, displayY: -50, offsetY: 520, opacity: 0.65 });
    store.flush();
    const restored = new ResidentStore(folder).load().dock;
    expect(restored).toMatchObject({
      side: 'left', displayId: 42, displayX: -2560, displayY: -50,
      offsetY: 520, opacity: 0.65,
    });
  });

  it('recovers a second monitor after its display ID changes, and clamps vertical offset', () => {
    const dock = normalizeResident({ dock: { side: 'right', opacity: 0.8,
      displayId: 200, displayX: -1920, displayY: 0, offsetY: 2000 } }).dock;
    expect(findSavedDockDisplay(dock, [area])?.id).toBe(100);
    expect(dockWindowBounds(dock, area)).toEqual({ x: -38, y: 1002, width: 38, height: 78 });
    expect(findSavedDockDisplay({ ...dock, displayX: 9000 }, [area])).toBeNull();
  });

  it('eases native transitions without detached-edge or vertical overshoot', () => {
    const initial = { x: 1882, y: 980, width: 38, height: 78 };
    const expanded = { x: 1482, y: 592, width: 438, height: 488 };
    expect(interpolateDockBounds(initial, expanded, 0)).toEqual(initial);
    expect(interpolateDockBounds(initial, expanded, 1)).toEqual(expanded);
    let previous = initial.width;
    for (let step = 1; step < 20; step++) {
      const middle = interpolateDockBounds(initial, expanded, step / 20);
      expect(middle.x + middle.width).toBe(1920);
      expect(middle.width).toBeGreaterThanOrEqual(previous);
      expect(middle.y).toBeGreaterThanOrEqual(expanded.y);
      expect(middle.y).toBeLessThanOrEqual(initial.y);
      previous = middle.width;
    }
    const onLeft = interpolateDockBounds(
      { x: -1920, y: 400, width: 42, height: 120 },
      { x: -1920, y: 400, width: 438, height: 488 }, 0.5);
    expect(onLeft.x).toBe(-1920);
    expect(onLeft.width).toBeGreaterThan(42);
    expect(onLeft.width).toBeLessThan(438);
  });

  it('normalizes and persists appearance and compact size with bounded native geometry', () => {
    const micro = normalizeResident({ dock: {} }).dock;
    expect(micro).toMatchObject({ appearance: 'moonsea', compactSize: 'micro' });
    expect(dockWindowBounds(micro, area)).toMatchObject({ width: 38, height: 78 });
    const compact = normalizeResident({ dock: { compactSize: 'compact', appearance: 'mist',
      side: 'right', offsetY: 2200 } }).dock;
    expect(compact).toMatchObject({ appearance: 'mist', compactSize: 'compact' });
    expect(dockWindowBounds(compact, area)).toEqual({ x: -42, y: 960, width: 42, height: 120 });
    expect(normalizeResident({ dock: { compactSize: 'nonsense', appearance: 'purple' } }).dock)
      .toMatchObject({ compactSize: 'micro', appearance: 'moonsea' });
  });

});
