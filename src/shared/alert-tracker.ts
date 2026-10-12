import type { MonitorAlert, MonitorState, ScanResponse, SessionRecord } from './types';

const RECENT_EVENT_MS = 120_000;
const MAX_ALERTS = 60;

type KnownSession = Pick<SessionRecord, 'status' | 'updatedAt' | 'finishedToken' | 'waitingToken'>;

/** A source may temporarily disappear during SSH failures. Never infer transitions from errors. */
export class AlertTracker {
  private known = new Map<string, Map<string, KnownSession>>();
  private scanned = new Map<string, number>();
  private seenAlertIds = new Set<string>();
  private alerts: MonitorAlert[] = [];
  private muted = false;

  setMuted(muted: boolean): void { this.muted = muted; }
  getMuted(): boolean { return this.muted; }
  getAlerts(): MonitorAlert[] { return this.alerts.map(alert => ({ ...alert })); }

  acknowledge(id: string): void {
    this.alerts = this.alerts.map(alert => alert.id === id ? { ...alert, read: true } : alert);
  }

  state(scan: ScanResponse | null): MonitorState {
    return { scan, alerts: this.getAlerts(), muted: this.muted };
  }

  observe(scan: ScanResponse, now = Date.now()): MonitorAlert[] {
    const pending: MonitorAlert[] = [];
    for (const source of scan.sources) {
      if (source.error) continue;
      const previous = this.known.get(source.id);
      const priorScan = this.scanned.get(source.id);
      const current = new Map<string, KnownSession>();

      for (const session of source.sessions) {
        const prior = previous?.get(session.key);
        const knownBefore = typeof priorScan === 'number';
        const newSincePreviousScan = priorScan != null && session.updatedAt > priorScan;
        const fresh = session.updatedAt <= now + 10_000 && now - session.updatedAt <= RECENT_EVENT_MS;
        const changed = prior ? session.updatedAt > prior.updatedAt : newSincePreviousScan;
        const newlyFinishedTurn = session.status === 'finished' && !!prior &&
          !!session.finishedToken && !!prior.finishedToken &&
          session.finishedToken !== prior.finishedToken && changed;

        let kind: 'finished' | 'waiting' | null = null;
        if (knownBefore && fresh && changed) {
          if (session.status === 'waiting' && (!prior || prior.status !== 'waiting' ||
            (!!session.waitingToken && session.waitingToken !== prior.waitingToken))) {
            kind = 'waiting';
          } else if (session.status === 'finished' && (!prior || prior.status !== 'finished' || newlyFinishedTurn)) {
            kind = 'finished';
          }
        }
        if (kind) {
          const token = kind === 'finished' ? session.finishedToken : session.waitingToken;
          // A stable event marker is preferable to file mtime; mtime is only a fallback
          // when the source does not persist per-turn IDs or event timestamps.
          const identity = token || String(session.updatedAt);
          const id = JSON.stringify([session.key, kind, identity]);
          if (!this.seenAlertIds.has(id)) {
            this.seenAlertIds.add(id);
            pending.push({
              id, sessionKey: session.key, sessionId: session.id, kind,
              title: session.title || '未命名会话', sourceLabel: session.sourceLabel,
              workspace: session.workspace, at: now, read: false,
              statusReason: session.statusReason,
            });
          }
        }
        current.set(session.key, {
          status: session.status, updatedAt: session.updatedAt,
          finishedToken: session.finishedToken, waitingToken: session.waitingToken,
        });
      }
      this.known.set(source.id, current);
      this.scanned.set(source.id, scan.scannedAt);
    }
    this.alerts = [...pending, ...this.alerts].slice(0, MAX_ALERTS);
    // A bounded, in-memory event history; never duplicate within the retained window.
    if (this.seenAlertIds.size > 500) this.seenAlertIds = new Set(this.alerts.map(alert => alert.id));
    return pending;
  }
}
