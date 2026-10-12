import type { MonitorAlert, MonitorState, ScanResponse, SessionRecord } from './types';

const RECENT_EVENT_MS = 120_000;
const CONTIGUOUS_SCAN_GAP_MS = 90_000;
const MAX_ALERTS = 60;

type KnownSession = Pick<SessionRecord,
  'status' | 'updatedAt' | 'byteSize' | 'finishedToken' | 'waitingToken'>;

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
      const lastSuccessfulScan = this.scanned.get(source.id);
      const knownBefore = lastSuccessfulScan != null;
      const gap = knownBefore ? now - lastSuccessfulScan : Infinity;
      const continuouslyObserved = gap >= 0 && gap <= CONTIGUOUS_SCAN_GAP_MS;
      const current = new Map<string, KnownSession>();

      for (const session of source.sessions) {
        const prior = previous?.get(session.key);
        const kind: 'finished' | 'waiting' | null =
          session.status === 'finished' ? 'finished' :
          session.status === 'waiting' ? 'waiting' : null;

        if (kind && knownBefore) {
          const token = kind === 'finished' ? session.finishedToken : session.waitingToken;
          const priorToken = prior &&
            (kind === 'finished' ? prior.finishedToken : prior.waitingToken);
          const changed = prior ? fileOrEventChanged(prior, session, token, priorToken) : true;
          const newTerminal = !prior || prior.status !== session.status ||
            (!!token && token !== priorToken);
          // Two adjacent successful scans bound the completion to that observation
          // interval, regardless of SSH/WSL clock skew or metadata timestamps.
          // On reconnect or for a newly discovered session, require a locally
          // calculated age from the source host to avoid stale alert floods.
          const recentlyObserved = prior
            ? continuouslyObserved || recentAtSource(session, now)
            : recentAtSource(session, now);

          if (changed && newTerminal && recentlyObserved) {
            const identity = token || [session.updatedAt, session.byteSize ?? '?'].join(':');
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
        }

        current.set(session.key, {
          status: session.status, updatedAt: session.updatedAt,
          byteSize: session.byteSize,
          finishedToken: session.finishedToken, waitingToken: session.waitingToken,
        });
      }
      this.known.set(source.id, current);
      this.scanned.set(source.id, now);
    }
    this.alerts = [...pending, ...this.alerts].slice(0, MAX_ALERTS);
    if (this.seenAlertIds.size > 500) {
      this.seenAlertIds = new Set(this.alerts.map(alert => alert.id));
    }
    return pending;
  }
}
