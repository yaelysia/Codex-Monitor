import type { MonitorAlert, SourceResult } from './types';
import { sourceAlertKey } from './source-alert';

/** Real collector errors only; a connecting/fallback fs.watch channel is not
 * an offline source while its periodic read succeeds.
 */
export const SOURCE_FAILURE_GRACE_MS = 30_000;
const MAX_SOURCES = 48;

export interface SavedSourceHealth {
  sourceId: string;
  firstFailedAt: number | null;
  failures: number;
  offlineNotified: boolean;
}

export class SourceHealthTracker {
  private records = new Map<string, SavedSourceHealth>();

  restore(entries: readonly SavedSourceHealth[] = []): void {
    this.records = new Map(entries.slice(-MAX_SOURCES).map(item =>
      [item.sourceId, { ...item }]));
  }

  snapshot(): SavedSourceHealth[] {
    return [...this.records.values()].slice(-MAX_SOURCES).map(item => ({ ...item }));
  }

  forgetAbsent(known: ReadonlySet<string>): boolean {
    let changed = false;
    for (const id of this.records.keys()) if (!known.has(id)) {
      this.records.delete(id);
      changed = true;
    }
    return changed;
  }

  private makeAlert(source: SourceResult, kind: 'source-offline' | 'source-recovered',
    startedAt: number, now: number): MonitorAlert {
    const bad = kind === 'source-offline';
    return {
      id: JSON.stringify([sourceAlertKey(source.id), kind, String(startedAt)]),
      sessionKey: sourceAlertKey(source.id), sessionId: source.id,
      kind, title: source.label + (bad ? ' · 连接异常' : ' · 已恢复连接'),
      sourceLabel: source.label, workspace: null, at: now, read: false,
      statusReason: bad
        ? '持续采集失败；数据源的实时会话状态无法确认，请检查连接或采集配置'
        : '数据源已恢复成功采集；会话状态以本次读取结果为准',
      questionText: null,
    };
  }

  observe(source: SourceResult, now: number): MonitorAlert[] {
    const prior = this.records.get(source.id);
    if (source.error) {
      // No alert on a single transient scan failure. Initial startup errors
      // also wait for a second failure and a sustained evidence window.
      if (!prior || prior.firstFailedAt == null ||
          now < prior.firstFailedAt) {
        this.records.set(source.id, {
          sourceId: source.id, firstFailedAt: now,
          failures: 1, offlineNotified: false,
        });
        return [];
      }
      const current = { ...prior, failures: Math.min(1000, prior.failures + 1) };
      const shouldNotify = !current.offlineNotified && current.failures >= 2 &&
        now - current.firstFailedAt! >= SOURCE_FAILURE_GRACE_MS;
      if (shouldNotify) current.offlineNotified = true;
      this.records.set(source.id, current);
      return shouldNotify ? [this.makeAlert(source, 'source-offline',
        current.firstFailedAt!, now)] : [];
    }

    this.records.set(source.id, {
      sourceId: source.id, firstFailedAt: null, failures: 0,
      offlineNotified: false,
    });
    if (this.records.size > MAX_SOURCES) this.records.delete(this.records.keys().next().value!);
    // Recovery only follows an outage that actually generated an alert.
    return prior?.offlineNotified && prior.firstFailedAt != null
      ? [this.makeAlert(source, 'source-recovered', prior.firstFailedAt, now)] : [];
  }
}
