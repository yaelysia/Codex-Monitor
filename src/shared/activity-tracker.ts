import type { SourceResult } from './types';

// An agent can remain silent while compacting context, awaiting a model
// response, or running a long command. Do not turn a previous *observed*
// active turn into "unknown" after only 90 seconds.
const GROWTH_WINDOW_MS = 45_000;
const DIRECT_ACTIVITY_WINDOW_MS = 90_000;
export const SILENCE_GRACE_MS = 8 * 60_000;

interface Observation {
  sourceId: string;
  modifiedAt: number;
  bytes: number;
  /** Last positive activity evidence (rollout mtime); never advance on silence. */
  evidenceAt: number;
}

/** In-memory evidence continuity; never reports a definite process-running state. */
export class SessionActivityTracker {
  private observed = new Map<string, Observation>();

  annotate(sources: SourceResult[], now: number): void {
    const successfulSources = new Set<string>();
    const liveKeys = new Set<string>();

    for (const source of sources) {
      if (source.error) continue; // A failed SSH/WSL read must not erase earlier evidence.
      successfulSources.add(source.id);
      for (const session of source.sessions) {
        liveKeys.add(session.key);
        const previous = this.observed.get(session.key);
        const bytes = session.byteSize ?? -1;
        const reset = !!previous &&
          (session.updatedAt < previous.modifiedAt || (bytes >= 0 && previous.bytes >= 0 && bytes < previous.bytes));
        // SSH and WSL file timestamps belong to their own machine's clock.
        // Use the source-relative age to evaluate freshness, then translate
        // observed evidence onto the local clock for bounded silence grace.
        const age = typeof session.ageAtSourceMs === 'number' &&
          Number.isFinite(session.ageAtSourceMs)
          ? session.ageAtSourceMs : now - session.updatedAt;
        const positiveEvidenceAt = now - Math.max(0, age);
        const growth = !!previous && !reset && bytes > previous.bytes && previous.bytes >= 0 &&
          session.updatedAt >= previous.modifiedAt && age >= -10_000 && age <= GROWTH_WINDOW_MS;
        const recentActivity = session.status === 'working' &&
          age >= -10_000 && age <= DIRECT_ACTIVITY_WINDOW_MS;
        let evidenceAt = !reset ? (previous?.evidenceAt ?? 0) : 0;

        if (session.status === 'finished' || session.status === 'waiting' ||
          session.status === 'interrupted' || session.status === 'failed') {
          // Explicit completion/approval evidence always overrides any retained activity.
          evidenceAt = 0;
        } else if (recentActivity || growth) {
          evidenceAt = Math.max(evidenceAt, positiveEvidenceAt);
        }

        if (session.status === 'unknown') {
          if (growth) {
            session.status = 'working';
            session.evidenceKind = 'recent-activity';
            session.statusReason = '相邻扫描中检测到会话日志文件增长，可能执行中；未获得客户端实时状态';
          } else if (previous && evidenceAt > 0 && now >= evidenceAt &&
            now - evidenceAt <= SILENCE_GRACE_MS) {
            session.status = 'working';
            session.evidenceKind = 'retained-activity';
            session.statusReason =
              '此前观察到执行活动，但目前没有新日志；上下文压缩、长工具调用或网络等待期间可能持续静默。' +
              '仅临时维持「可能执行中」，静默超过 8 分钟后回退未知。';
          }
        }

        // A rollout/remote scanner's "working" remains an inference.
        if (session.status === 'working' && !session.evidenceKind)
          session.evidenceKind = recentActivity ? 'recent-activity' : 'retained-activity';

        this.observed.set(session.key, {
          sourceId: source.id, modifiedAt: session.updatedAt, bytes, evidenceAt,
        });
      }
    }

    // A successful scan proves disappeared sessions are no longer in its recent-session index.
    // Keep observations for temporarily failing sources, but never extend their evidence clocks.
    for (const [key, value] of this.observed) {
      if (successfulSources.has(value.sourceId) && !liveKeys.has(key)) this.observed.delete(key);
    }
  }
}
