import type { SessionRecord } from './types';

const ACTIVE_WINDOW_MS = 90_000;
const WAIT_WINDOW_MS = 10 * 60_000;
const MAX_CACHE_SIZE = 220;
interface Cached {
  modified: number;
  size: number;
  snapshot: SessionRecord;
}

/** Small metadata-only cache. No raw JSONL, conversation text or tool output is retained. */
export class LocalScanCache {
  private entries = new Map<string, Cached>();
  private hits = 0;
  private misses = 0;

  get(file: string, modified: number, size: number, now: number): SessionRecord | null {
    const cached = this.entries.get(file);
    if (!cached || cached.modified !== modified || cached.size !== size) {
      this.misses++;
      return null;
    }
    this.hits++;
    const row: SessionRecord = { ...cached.snapshot, ageAtSourceMs: now - modified };
    const age = now - modified;
    if (row.status === 'working' && age > ACTIVE_WINDOW_MS) {
      row.status = 'unknown';
      row.statusReason = '最近未写入新日志；无法直接确认是否仍执行中（将检查此前活动证据）';
    } else if (row.status === 'waiting' && age > WAIT_WINDOW_MS) {
      row.status = 'unknown';
      row.waitingToken = null;
      row.statusReason = '此前存在等待操作事件，但日志已长时间未更新；等待状态无法确认';
    }
    return row;
  }

  put(file: string, modified: number, size: number, row: SessionRecord): void {
    this.entries.set(file, { modified, size, snapshot: { ...row } });
    while (this.entries.size > MAX_CACHE_SIZE) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
  }

  retain(files: ReadonlySet<string>): void {
    for (const key of this.entries.keys()) {
      if (!files.has(key)) this.entries.delete(key);
    }
  }

  stats(): { entries: number; hits: number; misses: number } {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses };
  }
  reset(): void { this.entries.clear(); this.hits = 0; this.misses = 0; }
}
