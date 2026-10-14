import fs from 'node:fs';
import path from 'node:path';
import { normalizeDock, validBounds, type SavedBounds, type SavedDock } from '../src/shared/window-geometry';

export interface ResidentPreferences {
  keepRunningOnClose: boolean;
  launchAtLogin: boolean;
}
export interface ResidentSnapshot {
  preferences: ResidentPreferences;
  mainBounds: SavedBounds | null;
  dock: SavedDock;
}
export const DEFAULT_PREFERENCES: ResidentPreferences = {
  keepRunningOnClose: true,
  launchAtLogin: false,
};
export function normalizeResident(raw: unknown): ResidentSnapshot {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const input = obj.preferences && typeof obj.preferences === 'object' && !Array.isArray(obj.preferences)
    ? obj.preferences as Record<string, unknown> : {};
  return {
    preferences: {
      keepRunningOnClose: input.keepRunningOnClose !== false,
      launchAtLogin: input.launchAtLogin === true,
    },
    mainBounds: validBounds(obj.mainBounds) ? { ...obj.mainBounds } : null,
    dock: normalizeDock(obj.dock),
  };
}

/** Tiny local JSON store. State never includes session contents or credentials.
 * Window moves are debounced; quit can flush synchronously before process exit. */
export class ResidentStore {
  private readonly file: string;
  private state: ResidentSnapshot = normalizeResident(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory: string) {
    this.file = path.join(directory, 'resident-state.json');
  }
  load(): ResidentSnapshot {
    try {
      this.state = normalizeResident(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch { this.state = normalizeResident(null); }
    return this.snapshot();
  }
  snapshot(): ResidentSnapshot {
    return {
      preferences: { ...this.state.preferences },
      mainBounds: this.state.mainBounds ? { ...this.state.mainBounds } : null,
      dock: { ...this.state.dock },
    };
  }
  updatePreferences(prefs: ResidentPreferences): void {
    this.state.preferences = { ...prefs };
    this.flush();
  }
  updateMainBounds(bounds: SavedBounds): void {
    if (!validBounds(bounds)) return;
    this.state.mainBounds = { ...bounds };
    this.schedule();
  }
  updateDock(dock: SavedDock): void {
    this.state.dock = normalizeDock(dock);
    this.schedule();
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 700);
    this.timer.unref?.();
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      console.warn('Failed to save Codex Monitor resident preferences:', error);
    }
  }
}
