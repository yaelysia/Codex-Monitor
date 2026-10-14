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
export const MIN_DOCK_OPACITY = 0.4;
export const MAX_DOCK_OPACITY = 1;
/** The opacity of the whole window; missing legacy values default to fully opaque. */
export function normalizeDockOpacity(input: unknown): number {
  if (!isNumber(input)) return 1;
  return Math.round(Math.max(MIN_DOCK_OPACITY, Math.min(MAX_DOCK_OPACITY, input)) * 100) / 100;
}
export type DockAppearance = 'moonsea' | 'ember' | 'mist';
export type DockCompactSize = 'micro' | 'compact';
export interface SavedDock {
  side: DockSide;
  displayId: number | null;
  offsetY: number;
  expanded: boolean;
  visible: boolean;
  opacity: number;
  /** UI-only fields; older resident files normalize to their defaults. */
  appearance?: DockAppearance;
  compactSize?: DockCompactSize;
  /** Screen origin also survives Windows changing its display IDs after restart. */
  displayX?: number | null;
  displayY?: number | null;
}

export function normalizeDock(value: unknown): SavedDock {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  return {
    side: row.side === 'left' ? 'left' : 'right',
    displayId: isNumber(row.displayId) ? row.displayId : null,
    offsetY: isNumber(row.offsetY) ? Math.min(100_000, Math.max(0, row.offsetY)) : 92,
    expanded: row.expanded === true,
    visible: row.visible !== false,
    opacity: normalizeDockOpacity(row.opacity),
    appearance: row.appearance === 'ember' || row.appearance === 'mist' ? row.appearance : 'moonsea',
    compactSize: row.compactSize === 'compact' ? 'compact' : 'micro',
    displayX: isNumber(row.displayX) ? row.displayX : null,
    displayY: isNumber(row.displayY) ? row.displayY : null,
  };
}

/** Prefer the same monitor; recover by desktop position if Windows changes display IDs. */
export function findSavedDockDisplay(dock: SavedDock, areas: WorkArea[]): WorkArea | null {
  const byId = areas.find(area => area.id === dock.displayId);
  if (byId) return byId;
  if (!isNumber(dock.displayX) || !isNumber(dock.displayY)) return null;
  return areas.find(area => Math.abs(area.x - dock.displayX!) < 96 &&
    Math.abs(area.y - dock.displayY!) < 96) ?? null;
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

/** Interpolate native dock bounds with both the size and the attached edge moving together.
 * Keeping the right edge fixed avoids the apparent sideways hop when the dock grows.
 */
export function interpolateDockBounds(from: SavedBounds, to: SavedBounds, progress: number): SavedBounds {
  const t = Math.max(0, Math.min(1, progress));
  const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * eased);
  const width = mix(from.width, to.width);
  const height = mix(from.height, to.height);
  const anchoredRight = from.x + from.width === to.x + to.width;
  return {
    x: anchoredRight ? from.x + from.width - width : mix(from.x, to.x),
    y: mix(from.y, to.y),
    width, height,
  };
}

export function dockWindowBounds(dock: SavedDock, workArea: WorkArea): SavedBounds {
  // Native bounds must match the visible rail. A transparent 276px hit area
  // would intercept clicks even if the CSS only painted a 78px capsule.
  const width = Math.min(dock.expanded ? 438 : dock.compactSize === 'compact' ? 42 : 38, workArea.width);
  const height = Math.min(dock.expanded ? 488 : dock.compactSize === 'compact' ? 120 : 78, workArea.height);
  return {
    width, height,
    x: dock.side === 'right' ? workArea.x + workArea.width - width : workArea.x,
    y: workArea.y + Math.min(Math.max(0, dock.offsetY), Math.max(0, workArea.height - height)),
  };
}
