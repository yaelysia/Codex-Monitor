import type { MonitorAlert, MonitorState, ScanResponse, SessionRecord } from './types';
import type { DesktopLogEvent } from './desktop-log-status';

const RECENT_EVENT_MS = 120_000;
const CONTIGUOUS_SCAN_GAP_MS = 90_000;
const MAX_ALERTS = 60;
export const MAX_SEEN_ALERT_IDS = 500;
export interface SavedAlert {
  id: string;
  sessionKey: string;
  sessionId: string;
  kind: 'finished' | 'waiting';
  at: number;
  read: boolean;
}
export interface AlertTrackerPersistence {
  version: 1;
  muted: boolean;
  alerts: SavedAlert[];
  seenAlertIds: string[];
}

type KnownSession = Pick<SessionRecord,
  'status' | 'updatedAt' | 'byteSize' | 'finishedToken' | 'waitingToken' |
  'pendingQuestionToken' | 'isSubagent'>;

/** Compare file mtime with the clock of the machine that owns it, not with Windows. */
function recentAtSource(session: SessionRecord, now: number): boolean {
  const age = session.ageAtSourceMs;
  if (typeof age === 'number' && Number.isFinite(age)) {
    return age >= -10_000 && age <= RECENT_EVENT_MS;
  }
  // Compatibility with old local records that do not carry source-relative age.
  return now - session.updatedAt >= -10_000 &&
    now - session.updatedAt <= RECENT_EVENT_MS;
}

function fileOrEventChanged(previous: KnownSession, session: SessionRecord,
  token: string | null | undefined, previousToken: string | null | undefined): boolean {
  return session.updatedAt !== previous.updatedAt ||
    (session.byteSize != null && previous.byteSize != null &&
      session.byteSize !== previous.byteSize) ||
    (!!token && token !== previousToken);
}

/** A source may temporarily disappear during SSH failures. Never infer transitions from errors. */
export class AlertTracker {
  private known = new Map<string, Map<string, KnownSession>>();
  private scanned = new Map<string, number>();
  private seenAlertIds = new Set<string>();
  private alerts: MonitorAlert[] = [];
  private muted = false;

  setMuted(muted: boolean): void { this.muted = muted; }
  getMuted(): boolean { return this.muted; }

  /** Restore ONLY validated metadata, never stored conversation titles/prompts. */
  restore(snapshot: AlertTrackerPersistence | null): void {
    if (!snapshot) return;
    this.muted = snapshot.muted;
    this.seenAlertIds = new Set(snapshot.seenAlertIds.slice(-MAX_SEEN_ALERT_IDS));
    this.alerts = snapshot.alerts.slice(0, MAX_ALERTS).map(item => {
      this.seenAlertIds.add(item.id);
      return {
        ...item, title: '已保存的任务提醒', sourceLabel: '历史来源',
        workspace: null, statusReason: '历史提醒；请打开当前会话查看最新状态',
        questionText: null,
      };
    });
  }

  /** Persist an intentionally small whitelist; no title, prompt or workspace. */
  snapshot(): AlertTrackerPersistence {
    return {
      version: 1, muted: this.muted,
      alerts: this.alerts.slice(0, MAX_ALERTS).map(item => ({
        id: item.id, sessionKey: item.sessionKey, sessionId: item.sessionId,
        kind: item.kind, at: item.at, read: item.read,
      })),
      seenAlertIds: [...this.seenAlertIds].slice(-MAX_SEEN_ALERT_IDS),
    };
  }

  getAlerts(scan: ScanResponse | null = null): MonitorAlert[] {
    if (!this.alerts.length) return [];
    // Most alerts already carry current public metadata. Build a session
    // lookup only when restoring a redacted historical inbox, not on every
    // foreground update or four-second Desktop audit.
    if (!scan || !this.alerts.some(alert =>
        alert.title === '已保存的任务提醒' || alert.sourceLabel === '历史来源')) {
      return this.alerts.map(alert => ({ ...alert }));
    }
    const byKey = new Map(scan.sources.flatMap(src => src.sessions)
      .map(session => [session.key, session]));
    return this.alerts.map(alert => {
      const live = byKey.get(alert.sessionKey);
      return { ...alert,
        title: alert.title === '已保存的任务提醒' ? (live?.title || alert.title) : alert.title,
        sourceLabel: alert.sourceLabel === '历史来源' ? (live?.sourceLabel || alert.sourceLabel) : alert.sourceLabel,
        workspace: alert.workspace ?? live?.workspace ?? null,
      };
    });
  }

  /** Recognize the SAME completion reported by GUI and rollout even if the
   * two sources write different timestamps. The UUID is the stable turn key.
   */
  private alreadyNotifiedTurn(key: string, turnId: string): boolean {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(turnId)) return false;
    for (const id of this.seenAlertIds) {
      try {
        const parts: unknown = JSON.parse(id);
        if (!Array.isArray(parts) || parts.length !== 3 ||
            parts[0] !== key || parts[1] !== 'finished' ||
            typeof parts[2] !== 'string') continue;
        if (parts[2] === 'desktop:' + turnId ||
            parts[2].endsWith('|' + turnId)) return true;
      } catch { /* Ignore malformed legacy alert ID. */ }
    }
    return false;
  }

  /** Native GUI completion notifications are distinct from filesystem scans.
   * A first-party completion must be newer than this running Monitor instance,
   * exact-thread matched, recent, and never a child-agent notification.
   */
  observeDesktopCompletions(
    snapshot: ScanResponse, evidence: readonly DesktopLogEvent[],
    startedAt: number, now = Date.now(),
  ): MonitorAlert[] {
    if (startedAt <= 0 || !snapshot.sources.length) return [];
    const matching = new Map<string, SessionRecord>();
    for (const source of snapshot.sources) {
      if (source.error) continue;
      for (const row of source.sessions) {
        if (row.isSubagent || matching.has(row.id.toLowerCase())) continue;
        matching.set(row.id.toLowerCase(), row);
      }
    }
    const pending: MonitorAlert[] = [];
    for (const event of evidence) {
      if (event.type !== 'turn-displayed-complete' || !event.turnId ||
          event.at < startedAt || event.at > now + 5_000 ||
          now - event.at > 120_000) continue;
      const row = matching.get(event.threadId.toLowerCase());
      // A displayed turn completion does not resolve an outstanding
      // asynchronous question, approval, failure or interruption.
      if (!row || row.pendingQuestionToken || row.status === 'waiting' ||
          row.status === 'failed' || row.status === 'interrupted' ||
          this.alreadyNotifiedTurn(row.key, event.turnId)) continue;
      const id = JSON.stringify([row.key, 'finished', 'desktop:' + event.turnId]);
      if (this.seenAlertIds.has(id)) continue;
      this.seenAlertIds.add(id);
      pending.push({
        id, sessionKey: row.key, sessionId: row.id, kind: 'finished',
        title: row.title || '未命名会话', sourceLabel: row.sourceLabel,
        workspace: row.workspace, at: now, read: false,
        statusReason: 'Codex Desktop 自身日志确认本轮完成（独立于 JSONL 扫描）',
        questionText: null,
      });
    }
    if (pending.length) {
      this.alerts = [...pending, ...this.alerts].slice(0, MAX_ALERTS);
      if (this.seenAlertIds.size > MAX_SEEN_ALERT_IDS)
        this.seenAlertIds = new Set([...this.seenAlertIds].slice(-MAX_SEEN_ALERT_IDS));
    }
    return pending;
  }

  acknowledge(id: string): void { this.acknowledgeMany([id]); }

  /** Only alerts already present when navigation began may be acknowledged. */
  acknowledgeMany(ids: readonly string[]): void {
    if (!ids.length) return;
    const selected = new Set(ids);
    this.alerts = this.alerts.map(alert => !alert.read && selected.has(alert.id)
      ? { ...alert, read: true } : alert);
  }

  state(scan: ScanResponse | null): MonitorState {
    return { scan, alerts: this.getAlerts(scan), muted: this.muted };
  }

  observe(scan: ScanResponse, now = Date.now()): MonitorAlert[] {
    const pending: MonitorAlert[] = [];
    for (const source of scan.sources) {
      if (source.error) continue;
      const previous = this.known.get(source.id);
      const lastSuccessfulScan = this.scanned.get(source.id);
      const knownBefore = lastSuccessfulScan != null;
      const gap = knownBefore ? now - lastSuccessfulScan : Infinity;
      const continuouslyObserved = gap >= 0 && gap <= CONTIGUOUS_SCAN_GAP_MS;
      const current = new Map<string, KnownSession>();

      for (const session of source.sessions) {
        const prior = previous?.get(session.key);
        const questionToken = session.pendingQuestionToken;
        // An asynchronous question may be unanswered while Codex continues
        // working or after its current turn finished. Such a request deserves
        // a waiting notification, not a fabricated process-waiting state.
        const kind: 'finished' | 'waiting' | null =
          questionToken ? 'waiting' :
          session.status === 'finished' ? 'finished' :
          session.status === 'waiting' ? 'waiting' : null;

        if (kind && knownBefore) {
          const token = kind === 'finished' ? session.finishedToken :
            (questionToken || session.waitingToken);
          const priorToken = prior && (kind === 'finished' ? prior.finishedToken :
            (prior.pendingQuestionToken || prior.waitingToken));
          const changed = prior ? fileOrEventChanged(prior, session, token, priorToken) : true;
          const newTerminal = !prior || (questionToken
            ? questionToken !== prior.pendingQuestionToken
            : prior.status !== session.status || (!!token && token !== priorToken));
          // Two adjacent successful scans bound the completion to that observation
          // interval, regardless of SSH/WSL clock skew or metadata timestamps.
          // On reconnect or for a newly discovered session, require a locally
          // calculated age from the source host to avoid stale alert floods.
          const recentlyObserved = prior
            ? continuouslyObserved || recentAtSource(session, now)
            : recentAtSource(session, now);

          // Hide child-agent notifications (including wait events) by default.
          // A child remains in read-only scan results for optional inspection,
          // but is not a separate user-facing notification target.
          const childNotification = session.isSubagent === true || prior?.isSubagent === true;
          if (changed && newTerminal && recentlyObserved && !childNotification) {
            const identity = token || [session.updatedAt, session.byteSize ?? '?'].join(':');
            const id = JSON.stringify([session.key, kind, identity]);
            const finishedTurn = kind === 'finished' && token
              ? token.split('|').at(-1) : null;
            if (!this.seenAlertIds.has(id) &&
                !(finishedTurn && this.alreadyNotifiedTurn(session.key, finishedTurn))) {
              this.seenAlertIds.add(id);
              pending.push({
                id, sessionKey: session.key, sessionId: session.id, kind,
                title: session.title || '未命名会话', sourceLabel: session.sourceLabel,
                workspace: session.workspace, at: now, read: false,
                statusReason: session.statusReason,
                questionText: kind === 'waiting' ? session.questionText : null,
              });
            }
          }
        }

        current.set(session.key, {
          status: session.status, updatedAt: session.updatedAt,
          byteSize: session.byteSize, isSubagent: session.isSubagent,
          finishedToken: session.finishedToken, waitingToken: session.waitingToken,
          pendingQuestionToken: session.pendingQuestionToken,
        });
      }
      this.known.set(source.id, current);
      this.scanned.set(source.id, now);
    }
    this.alerts = [...pending, ...this.alerts].slice(0, MAX_ALERTS);
    if (this.seenAlertIds.size > MAX_SEEN_ALERT_IDS) {
      this.seenAlertIds = new Set([...this.seenAlertIds].slice(-MAX_SEEN_ALERT_IDS));
      for (const alert of this.alerts) this.seenAlertIds.add(alert.id);
    }
    return pending;
  }
}
