import type { ScanResponse, SessionRecord } from './types';

/** Short display-only continuity for an intermittent "unknown"/missing row.
 * This must never become fresh execution evidence or manufacture a completion.
 */
export const TRANSIENT_RUNNING_GAP_MS = 15_000;
const MAX_HELD_ROWS_PER_SOURCE = 16;
const MAX_EPISODES = 96;

interface Episode { startedAt: number; sourceId: string }

/** The authoritative collector still owns terminal state and source errors.
 * Only an already-observed running parent can be kept tentatively visible for
 * one bounded episode of healthy-but-incomplete scan results. This matters
 * for 3-second watcher scans racing a JSONL append / source index refresh.
 */
export class RunningContinuity {
  private readonly gaps = new Map<string, Episode>();

  reset(): void { this.gaps.clear(); }

  project(previous: ScanResponse | null, incoming: ScanResponse,
    now = Date.now(), nativeCompleted: ReadonlySet<string> = new Set()): ScanResponse {
    if (!previous) return incoming;
    const bySource = new Map(previous.sources.map(source => [source.id, source]));
    const stillPresent = new Set<string>();
    let anyChanged = false;
    const sources = incoming.sources.map(source => {
      const old = bySource.get(source.id);
      if (!old || source.error || source.stale || old.error || old.stale) {
        this.forgetSource(source.id);
        for (const row of source.sessions) stillPresent.add(row.key);
        return source;
      }
      const previously = new Map(old.sessions.map(row => [row.key, row]));
      const found = new Set<string>();
      let rows: SessionRecord[] | null = null;
      const add = (row: SessionRecord): void => {
        if (!rows) rows = [...source.sessions];
        rows.push(row);
      };
      source.sessions.forEach((row, i) => {
        found.add(row.key);
        stillPresent.add(row.key);
        // A concrete lifecycle result always beats provisional display.
        if (row.status !== 'unknown' || row.isSubagent ||
            nativeCompleted.has(row.id.toLowerCase()) ||
            row.pendingQuestionToken || row.waitingToken ||
            row.finishedToken || row.interruptedToken || row.failedToken) {
          this.gaps.delete(row.key);
          return row;
        }
        const held = this.tryHold(row, previously.get(row.key), source.id, now);
        if (!held) return row;
        if (!rows) rows = [...source.sessions];
        rows[i] = held;
        return held;
      });
      // A recently active record might be missing for a single scan because
      // the file is mid-rollover or briefly outside a bounded recent index.
      // Keep at most 16 parent rows, never a phantom data source or subagent.
      let appended = 0;
      for (const oldRow of old.sessions) {
        if (appended >= MAX_HELD_ROWS_PER_SOURCE) break;
        if (found.has(oldRow.key) || oldRow.isSubagent ||
            nativeCompleted.has(oldRow.id.toLowerCase()) ||
            (!oldRow.rolloutPath && oldRow.clientKind !== 'desktop')) continue;
        const held = this.tryHold({
          ...oldRow, status: 'unknown', evidenceKind: undefined,
          statusReason: '本次采集未包含先前活动会话',
        }, oldRow, source.id, now);
        if (!held) continue;
        add(held);
        stillPresent.add(held.key);
        appended++;
      }
      if (!rows) return source;
      // The returned session array has been built in original source order
      // while preserving every new non-held row and all terminal markers.
      // rows were initialized from source.sessions; visible only changes
      // entries, and add() only appends missing prior records.
      anyChanged = true;
      return { ...source, sessions: rows };
    });
    for (const key of this.gaps.keys()) if (!stillPresent.has(key)) this.gaps.delete(key);
    return anyChanged ? { ...incoming, sources } : incoming;
  }

  private forgetSource(id: string): void {
    for (const [key, gap] of this.gaps) {
      if (gap.sourceId === id) this.gaps.delete(key);
    }
  }

  private tryHold(row: SessionRecord, previous: SessionRecord | undefined,
    sourceId: string, now: number): SessionRecord | null {
    if (!previous || previous.status !== 'working' ||
        previous.sourceId !== sourceId || row.sourceId !== sourceId ||
        row.isSubagent || previous.isSubagent ||
        row.pendingQuestionToken || row.waitingToken ||
        row.finishedToken || row.interruptedToken || row.failedToken) {
      this.gaps.delete(row.key);
      return null;
    }
    const prior = this.gaps.get(row.key);
    if (prior && (prior.sourceId !== sourceId ||
        now < prior.startedAt ||
        now - prior.startedAt >= TRANSIENT_RUNNING_GAP_MS)) {
      this.gaps.delete(row.key);
      return null;
    }
    if (!prior) {
      if (this.gaps.size >= MAX_EPISODES) {
        // Fail open (unknown) rather than silently evict an existing episode
        // and let its still-running projection repeatedly restart the grace.
        return null;
      }
      this.gaps.set(row.key, { sourceId, startedAt: now });
    }
    return { ...row, status: 'working', evidenceKind: 'retained-activity',
      statusReason: '最近已观察到执行中，但此次采集暂缺明确执行状态；' +
        '仅临时保留最多 15 秒的「可能执行中」显示，不代表已验证进程仍在运行' };
  }
}
