/** Best-effort Windows Desktop log-change wakeups. This is a notification
 * source, NOT a replacement for bounded periodic lifecycle audits.
 * No filenames, log content, window metadata or Codex IPC are inspected.
 */
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export const MAX_DESKTOP_WATCH_DIRS = 8;
type Subscribe = (dir: string, changed: () => void) => FSWatcher;

export class DesktopLogFolderWatcher {
  private active = new Map<string, FSWatcher>();
  private desired = new Set<string>();
  private retryAfter = new Map<string, number>();
  private disposed = false;
  private complete = false;

  constructor(private readonly wake: () => void,
    private readonly subscribe: Subscribe = (dir, onChange) =>
      watch(dir, { persistent: false }, onChange)) {}

  get healthy(): boolean {
    return !this.disposed && this.complete &&
      this.desired.size > 0 && this.active.size === this.desired.size;
  }

  reconcile(directories: readonly string[], now = Date.now()): void {
    if (this.disposed) return;
    // More than eight independent log folders means we cannot guarantee full
    // watch coverage. Fall back to four-second bounded polling instead.
    const valid = [...new Set(directories.filter(dir =>
      typeof dir === 'string' && dir.length > 0 && path.isAbsolute(dir)))];
    this.complete = valid.length > 0 && valid.length <= MAX_DESKTOP_WATCH_DIRS;
    const selected = new Set(this.complete ? valid : []);
    for (const [dir, subscription] of this.active) {
      if (selected.has(dir)) continue;
      subscription.close();
      this.active.delete(dir);
      this.retryAfter.delete(dir);
    }
    this.desired = selected;
    for (const dir of selected) {
      if (this.active.has(dir) || now < (this.retryAfter.get(dir) ?? 0)) continue;
      try {
        const subscription = this.subscribe(dir, () => {
          if (!this.disposed) this.wake();
        });
        this.active.set(dir, subscription);
        subscription.on('error', () => {
          if (this.active.get(dir) !== subscription) return;
          this.active.delete(dir);
          subscription.close();
          this.retryAfter.set(dir, Date.now() + 30_000);
          if (!this.disposed) this.wake(); // Immediate fallback after failure.
        });
        this.retryAfter.delete(dir);
      } catch {
        this.retryAfter.set(dir, now + 30_000);
      }
    }
  }

  close(): void {
    this.disposed = true;
    this.complete = false;
    this.desired.clear();
    for (const subscription of this.active.values()) subscription.close();
    this.active.clear();
    this.retryAfter.clear();
  }
}
