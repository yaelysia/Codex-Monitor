import type { MonitorState, SessionStatus } from './types';
import type { NativeHealth, NativeConnection, NativeCoverageEntry, NativeCoverageReason,
  NativeLocalDiscovery } from './native-state';

export const DIAGNOSTIC_EVENT_LIMIT = 400;
const ENTITY_LIMIT = 1000;
const STATUS = new Set<SessionStatus>(['working','waiting','finished','failed','interrupted','unknown']);
export type DiagnosticKind = 'source' | 'session' | 'popup-requested' | 'popup-suppressed' | 'read';
export interface DiagnosticEvent {
  sequence: number; at: number; kind: DiagnosticKind;
  source: string; session?: string;
  status?: SessionStatus; evidence?: 'native' | 'desktop-log' | 'log';
  pending?: boolean; healthy?: boolean;
}
export interface DiagnosticReport {
  version: 1; generatedAt: number; capacity: number; dropped: number;
  sources: Array<{ ref: string; healthy: boolean; stale: boolean;
    channel: 'active' | 'connecting' | 'fallback'; capturedAt: number | null;
    sessions: number; durationMs: number | null; statCalls: number | null;
    cacheHits: number | null; indexMode: 'full' | 'incremental' | null;
    directoriesEnumerated: number | null }>;
  native: Array<Omit<NativeHealth, 'sourceId'> & { source: string }>;
  /** Counts only; never raw session IDs, endpoint addresses, or file paths. */
  coverage: Array<{ source: string; reason: NativeCoverageReason; count: number }>;
  events: DiagnosticEvent[];
}
export interface DiagnosticView {
  report: DiagnosticReport;
  /** Display-only identities: never included in report/export. */
  sessions: Array<{ key: string; ref: string; title: string; sourceLabel: string }>;
  /** Current session-specific cause, visible locally only; not in report/export. */
  coverage: Array<{ ref: string; source: string; reason: NativeCoverageReason }>;
}
export interface DiagnosticsApi {
  get(): Promise<DiagnosticView>;
  clear(): Promise<DiagnosticView>;
  exportReport(): Promise<'saved' | 'cancelled'>;
  getConnections(): Promise<NativeConnection[]>;
  setConnections(value: NativeConnection[]): Promise<NativeConnection[]>;
  discoverLocal(): Promise<NativeLocalDiscovery>;
}
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** A bounded metadata flight recorder. Never stores titles, paths, payloads or errors. */
export class DiagnosticRecorder {
  private events: DiagnosticEvent[] = [];
  private identities = new Map<string, string>();
  private previous = new Map<string, string>();
  private read = new Map<string, boolean>();
  private sequence = 0;
  private entity = 0;
  private dropped = 0;

  private ref(key: string, prefix: string): string {
    const full = prefix + ':' + key;
    let value = this.identities.get(full);
    if (!value) {
      value = prefix + (++this.entity);
      this.identities.set(full, value);
      if (this.identities.size > ENTITY_LIMIT) this.identities.delete(this.identities.keys().next().value!);
    }
    return value;
  }
  private append(event: Omit<DiagnosticEvent, 'sequence'>): void {
    this.events.push({ ...event, sequence: ++this.sequence });
    if (this.events.length > DIAGNOSTIC_EVENT_LIMIT) { this.events.shift(); this.dropped++; }
  }
  recordPopup(key: string, suppressed: boolean, state: MonitorState, now = Date.now()): void {
    for (const source of state.scan?.sources ?? []) {
      if (!source.sessions.some(row => row.key === key)) continue;
      this.append({ at: now, kind: suppressed ? 'popup-suppressed' : 'popup-requested',
        source: this.ref(source.id, 'S'), session: this.ref(key, 'T') });
      return;
    }
  }
  observe(state: MonitorState, now = Date.now()): void {
    const next = new Map<string, string>();
    for (const source of (state.scan?.sources ?? []).slice(0, 40)) {
      const sourceRef = this.ref(source.id, 'S');
      const channel = state.eventChannels?.[source.id] ?? 'fallback';
      const healthy = !source.error && !source.stale;
      const sourceSignature = JSON.stringify([healthy, channel]);
      next.set(sourceRef, sourceSignature);
      if (this.previous.get(sourceRef) !== sourceSignature)
        this.append({ at: now, kind: 'source', source: sourceRef, healthy });
      for (const row of source.sessions.slice(0, 216)) {
        if (next.size >= ENTITY_LIMIT) break;
        const session = this.ref(row.key, 'T');
        const status = STATUS.has(row.status) ? row.status : 'unknown';
        const evidence = row.nativeStatus ? 'native' : row.desktopRuntimeObserved ? 'desktop-log' : 'log';
        const pending = !!row.pendingQuestionToken || row.status === 'waiting';
        const signature = JSON.stringify([status, evidence, pending]);
        next.set(session, signature);
        if (this.previous.get(session) !== signature)
          this.append({ at: now, kind: 'session', source: sourceRef, session, status, evidence, pending });
      }
    }
    this.previous = next;
    const reads = new Map<string, boolean>();
    for (const alert of state.alerts.slice(0, 60)) {
      reads.set(alert.id, alert.read);
      if (alert.read && this.read.get(alert.id) === false) {
        const source = state.scan?.sources.find(src => src.sessions.some(row => row.key === alert.sessionKey));
        if (source) this.append({ at: now, kind: 'read', source: this.ref(source.id, 'S'),
          session: this.ref(alert.sessionKey, 'T') });
      }
    }
    this.read = reads;
  }
  snapshot(state: MonitorState, native: readonly NativeHealth[], now = Date.now(),
    coverage: readonly NativeCoverageEntry[] = []): DiagnosticView {
    const sources = (state.scan?.sources ?? []).slice(0, 40);
    const summary = new Map<string, { source: string; reason: NativeCoverageReason; count: number }>();
    for (const row of coverage.slice(0, 1000)) {
      const source = this.ref(row.sourceId, 'S');
      const key = JSON.stringify([source, row.reason]);
      const previous = summary.get(key);
      if (previous) previous.count++;
      else summary.set(key, { source, reason: row.reason, count: 1 });
    }
    const report: DiagnosticReport = {
      version: 1, generatedAt: now, capacity: DIAGNOSTIC_EVENT_LIMIT, dropped: this.dropped,
      sources: sources.map(src => ({ ref: this.ref(src.id, 'S'), healthy: !src.error,
        stale: !!src.stale, channel: state.eventChannels?.[src.id] ?? 'fallback',
        capturedAt: number(src.capturedAt), sessions: src.sessions.length,
        durationMs: number(src.scanMetrics?.durationMs), statCalls: number(src.scanMetrics?.statCalls),
        cacheHits: number(src.scanMetrics?.cacheHits),
        indexMode: src.scanMetrics?.indexMode ?? null,
        directoriesEnumerated: number(src.scanMetrics?.directoriesEnumerated) })),
      native: native.slice(0, 8).map(item => ({ source: this.ref(item.sourceId, 'S'),
        transport: item.transport, state: item.state, reason: item.reason,
        loaded: item.loaded, matched: item.matched, covered: item.covered,
        listComplete: item.listComplete, lastSuccessAt: number(item.lastSuccessAt),
        retries: item.retries, ignoredRequests: item.ignoredRequests,
        readRequests: item.readRequests ?? 0, passiveHints: item.passiveHints ?? 0 })),
      coverage: [...summary.values()].map(row => ({ ...row })),
      events: this.events.map(event => ({ ...event })),
    };
    return { report, sessions: sources.flatMap(src => src.sessions.slice(0,216).map(row => ({
      key: row.key, ref: this.ref(row.key, 'T'), title: row.title || '未命名会话', sourceLabel: src.label,
    }))).slice(0, ENTITY_LIMIT),
      coverage: coverage.slice(0, 1000).map(row => ({
        ref: this.ref(row.sessionKey, 'T'), source: this.ref(row.sourceId, 'S'), reason: row.reason,
      })) };
  }
  clear(): void {
    this.events = []; this.previous.clear(); this.identities.clear(); this.read.clear();
    this.sequence = 0; this.entity = 0; this.dropped = 0;
  }
}
