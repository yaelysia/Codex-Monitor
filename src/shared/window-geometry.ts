export interface SavedBounds { x: number; y: number; width: number; height: number }
export interface WorkArea extends SavedBounds { id: number }
export type DockSide = 'left' | 'right';

const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
export function validBounds(value: unknown): value is SavedBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return isNumber(r.x) && isNumber(r.y) && isNumber(r.width) && isNumber(r.height) &&
    r.width >= 320 && r.width <= 10_000 && r.height >= 200 && r.height <= 10_000;
}
export interface SavedDock { side: DockSide; displayId: number | null; offsetY: number; expanded: boolean; visible: boolean }

export function normalizeDock(value: unknown): SavedDock {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    side: row.side === 'left' ? 'left' : 'right',
    displayId: isNumber(row.displayId) ? row.displayId : null,
    offsetY: isNumber(row.offsetY) ? Math.min(100_000, Math.max(0, row.offsetY)) : 92,
    expanded: row.expanded === true,
    visible: row.visible !== false,
  };
}

/** Avoid restoring windows offscreen after monitors, resolution, or DPI change. */
export function restoreMainBounds(saved: unknown, areas: WorkArea[], fallback: SavedBounds): SavedBounds {
  if (!validBounds(saved) || !areas.length) return fallback;
  const area = areas.find(a => {
    const x = Math.max(0, Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x));
    const y = Math.max(0, Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y));
    return x >= 100 && y >= 80;
  });
  if (!area) return fallback;
  const width = Math.min(saved.width, area.width);
  const height = Math.min(saved.height, area.height);
  return {
    width, height,
    x: Math.min(Math.max(saved.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(saved.y, area.y), area.y + area.height - height),
  };
}

export function dockWindowBounds(dock: SavedDock, workArea: WorkArea): SavedBounds {
  const width = Math.min(dock.expanded ? 350 : 55, workArea.width);
  const height = Math.min(276, workArea.height);
  return {
    width, height,
    x: dock.side === 'right' ? workArea.x + workArea.width - width : workArea.x,
    y: workArea.y + Math.min(Math.max(0, dock.offsetY), Math.max(0, workArea.height - height)),
  };
}
