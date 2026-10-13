import fs from 'node:fs';
import path from 'node:path';
import type { DesktopLogEvent } from '../src/shared/desktop-log-status';

const MAX_BYTES = 64 * 1024;
const MAX_RECORDS = 200;

/** Read/write only strict turn IDs, event kinds and timestamps.
 * No logs, prompts, account names or workspace paths are stored.
 */
export class DesktopEvidenceStore {
  private readonly file: string;
  private pending: DesktopLogEvent[] = [];
  private lastJSON = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory: string) {
    this.file = path.join(directory, 'desktop-runtime-evidence.json');
  }

  load(): unknown[] {
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return [];
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const value = raw as Record<string, unknown>;
      if (value.version !== 1 || !Array.isArray(value.events)) return [];
      return value.events.slice(0, MAX_RECORDS * 2);
    } catch { return []; }
  }

  update(records: readonly DesktopLogEvent[]): void {
    const next = records.slice(0, MAX_RECORDS).map(item => ({
      threadId: item.threadId, at: item.at, type: item.type,
      ...(item.type === 'turn-displayed-complete' ? { turnId: item.turnId } : {}),
    }));
    const json = JSON.stringify({ version: 1, events: next });
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    this.pending = next;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 800);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.lastJSON) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, this.lastJSON, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      // A failed sidecar write must never stop normal filesystem monitoring.
    }
  }
}
