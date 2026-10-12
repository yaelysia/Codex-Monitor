import fs from 'node:fs';
import path from 'node:path';
import { normalizeSavedWindowBinding, type PersistedWindowBinding } from '../src/shared/auto-window-binding';

const MAX_READ_BYTES = 128 * 1024;
const MAX_ENTRIES = 200;

/** Isolated optional binding persistence. Invalid or stale identities are
 * ignored, never used as paths or commands, and never treated as verified.
 * This file holds only a HWND/PID/start time and opaque Codex session key.
 */
export class WindowBindingStore {
  private readonly file: string;
  private records: PersistedWindowBinding[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory: string) {
    this.file = path.join(directory, 'window-bindings.json');
  }

  load(now = Date.now()): PersistedWindowBinding[] {
    this.records = [];
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size > MAX_READ_BYTES) return [];
      const input: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
      const data = input as Record<string, unknown>;
      if (data.version !== 1 || !Array.isArray(data.bindings)) return [];
      const seen = new Set<string>();
      for (const raw of data.bindings.slice(0, MAX_ENTRIES * 2)) {
        const item = normalizeSavedWindowBinding(raw, now);
        if (!item || seen.has(item.sessionKey)) continue;
        this.records.push(item);
        seen.add(item.sessionKey);
        if (this.records.length >= MAX_ENTRIES) break;
      }
    } catch { /* Startup with no saved file or corrupt JSON is supported. */ }
    return this.records.map(item => ({ ...item, window: { ...item.window } }));
  }

  update(values: readonly PersistedWindowBinding[]): void {
    this.records = values.slice(0, MAX_ENTRIES).map(item => ({ ...item, window: { ...item.window } }));
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
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, bindings: this.records }),
        { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      console.warn('Unable to persist Codex Monitor window identities:', error);
    }
  }
}
