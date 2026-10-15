import type { ScanResponse, SourceResult } from './types';

/** Short outages should not erase the session index or the bounded active-rollout
 * pins. Expired snapshots are discarded rather than claiming indefinite liveness.
 */
export const SOURCE_RETENTION_MS = 24 * 60 * 60 * 1000;
interface HealthySnapshot { source: SourceResult; seenAt: number }

export class SourceRetention {
  private healthy = new Map<string, HealthySnapshot>();

  remember(source: SourceResult, now = Date.now()): void {
    if (source.error) return;
    this.healthy.set(source.id, { source, seenAt: now });
  }

  /** Retained rows are reference-only: active/waiting states become unknown.
   * Terminal history is preserved but explicitly labeled as potentially stale.
   */
  onFailure(failed: SourceResult, now = Date.now()): SourceResult {
    if (!failed.error) return failed;
    const previous = this.healthy.get(failed.id);
    if (!previous || now < previous.seenAt ||
        now - previous.seenAt > SOURCE_RETENTION_MS) return failed;
    const elapsed = Math.max(0, now - previous.seenAt);
    return {
      ...failed, stale: true, lastHealthyAt: previous.seenAt,
      sessions: previous.source.sessions.map(row => ({
        ...row,
        status: row.status === 'working' || row.status === 'waiting' ? 'unknown' : row.status,
        statusReason: '数据源失联；以下为上次成功采集的历史状态，当前运行或待处理情况未确认。' +
          ' 上次证据：' + row.statusReason,
        evidenceKind: undefined,
        desktopRuntimeObserved: undefined,
        // A previously outstanding request may already have been answered on
        // the disconnected machine. Do not show it as actionable in the dock.
        pendingQuestionToken: null,
        waitingToken: null,
        questionText: null,
        ageAtSourceMs: typeof row.ageAtSourceMs === 'number' &&
          Number.isFinite(row.ageAtSourceMs) ? row.ageAtSourceMs + elapsed : undefined,
      })),
    };
  }

  /** A failed source keeps the last known successful pin candidates; the
   * public scan still reports the current error and does not generate alerts.
   */
  pinSnapshot(now = Date.now()): ScanResponse {
    const sources: SourceResult[] = [];
    for (const [id, entry] of this.healthy) {
      if (now - entry.seenAt > SOURCE_RETENTION_MS || now < entry.seenAt) {
        this.healthy.delete(id);
      } else {
        sources.push(entry.source);
      }
    }
    return { scannedAt: now, sources };
  }

  forgetAbsent(ids: ReadonlySet<string>): void {
    for (const id of this.healthy.keys()) if (!ids.has(id)) this.healthy.delete(id);
  }
}
