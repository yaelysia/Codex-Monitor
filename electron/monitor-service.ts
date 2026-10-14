import { AlertTracker } from '../src/shared/alert-tracker';
import type { MonitorAlert, MonitorState, ScanResponse } from '../src/shared/types';
import { readSettings } from './config';
import { refresh as collect, projectDesktopRuntime, recentDesktopCompletions } from './collector';
import { WatchCoordinator } from './watchers';
import { mergeSourceSnapshots } from '../src/shared/scan-merge';
import { AlertStateStore } from './alert-store';
import { getDesktopLogMetrics } from './desktop-runtime-logs';
import { pinnedRolloutsBySource } from '../src/shared/pinned-rollouts';

const POLLING_FALLBACK_MS = 12_000;
const HEALTHY_CHANNEL_AUDIT_MS = 60_000;
const MIN_FULL_SCAN_GAP_MS = 9_000;
const EVENT_DEBOUNCE_MS = 400;
const MIN_SOURCE_SCAN_GAP_MS = 3_000;
// Bounded log-only audits are independent from expensive WSL/SSH metadata scans.
const DESKTOP_NATIVE_AUDIT_MS = 4_000;

function desktopProjectionChanged(a: ScanResponse | null, b: ScanResponse): boolean {
  if (!a || a.sources.length !== b.sources.length) return true;
  for (let i = 0; i < b.sources.length; i++) {
    const left = a.sources[i]!, right = b.sources[i]!;
    if (left.id !== right.id || left.sessions.length !== right.sessions.length) return true;
    for (let j = 0; j < right.sessions.length; j++) {
      const old = left.sessions[j]!, fresh = right.sessions[j]!;
      if (old.key !== fresh.key || old.status !== fresh.status ||
          old.statusReason !== fresh.statusReason ||
          old.finishedToken !== fresh.finishedToken ||
          old.desktopRuntimeObserved !== fresh.desktopRuntimeObserved ||
          old.evidenceKind !== fresh.evidenceKind) return true;
    }
  }
  return false;
}

/** One state owner and event queue for all renderer windows and external hosts. */
export class MonitorService {
  private tracker = new AlertTracker();
  private readonly alertStore: AlertStateStore | null;
  private lastSourceScanDurationMs: number | null = null;
  private lastScan: ScanResponse | null = null;
  private rawLastScan: ScanResponse | null = null;
  private nativeAuditTimer: ReturnType<typeof setInterval> | null = null;
  private nativeAuditInFlight = false;
  private inFlight: Promise<ScanResponse> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private watchers = new WatchCoordinator(
    sourceId => this.queueSource(sourceId),
    () => { if (this.running) this.onChange(this.state()); },
  );
  private pendingSources = new Set<string>();
  private lastEventScan = new Map<string, number>();
  private needsFullScan = false;
  /** Emergency switch for hosts that disallow watch connections. */
  private readonly eventsEnabled = process.env.CODEX_MONITOR_DISABLE_EVENT_WATCHERS !== '1';
  private lastFullScanAt = 0;
  private lastSourceScan = new Map<string, number>();
  private scanningFull = false;
  private running = false;
  private startedAt = 0;

  constructor(
    private readonly onChange: (state: MonitorState) => void,
    private readonly onAlert: (alert: MonitorAlert) => void,
    private readonly onScanned: (delta: ScanResponse) => void = () => {},
    private readonly platform = process.platform,
    storageDirectory?: string,
  ) {
    this.alertStore = storageDirectory ? new AlertStateStore(storageDirectory) : null;
    if (this.alertStore) this.tracker.restore(this.alertStore.load());
  }

  private persistAlerts(): void {
    this.alertStore?.update(this.tracker.snapshot());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    if (this.eventsEnabled) this.watchers.start();
    this.timer = setInterval(() => this.pollFallback(), POLLING_FALLBACK_MS);
    if (this.platform === 'win32' &&
        process.env.CODEX_MONITOR_DISABLE_DESKTOP_LOGS !== '1') {
      this.nativeAuditTimer = setInterval(() => {
        void this.auditDesktopRuntime();
      }, DESKTOP_NATIVE_AUDIT_MS);
      this.nativeAuditTimer.unref?.();
    }
    void this.refresh().catch(error => console.warn('Initial Codex scan failed:', error));
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.nativeAuditTimer) clearInterval(this.nativeAuditTimer);
    this.nativeAuditTimer = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.pendingSources.clear();
    this.watchers.stop();
    this.persistAlerts();
    this.alertStore?.flush();
  }

  state(): MonitorState {
    return {
      ...this.tracker.state(this.lastScan), eventChannels: this.watchers.status(),
      performance: {
        sourceScanDurationMs: this.lastSourceScanDurationMs,
        desktopAudit: this.platform === 'win32' ? getDesktopLogMetrics() : null,
      },
    };
  }
  setMuted(muted: boolean): MonitorState {
    this.tracker.setMuted(muted);
    this.persistAlerts();
    this.onChange(this.state());
    return this.state();
  }
  acknowledge(id: string): MonitorState { return this.acknowledgeMany([id]); }
  acknowledgeMany(ids: readonly string[]): MonitorState {
    if (!ids.length) return this.state();
    this.tracker.acknowledgeMany(ids);
    this.persistAlerts();
    this.onChange(this.state());
    return this.state();
  }

  /** Native status can update a known local/WSL/SSH session without waiting
   * for a new JSONL write or rescanning a slow remote filesystem.
   * The raw filesystem snapshot remains immutable; overlay can be removed or
   * superseded by newer native completion evidence on the next tick.
   */
  private async auditDesktopRuntime(): Promise<void> {
    const baseline = this.rawLastScan;
    if (!this.running || !baseline || this.inFlight || this.nativeAuditInFlight) return;
    this.nativeAuditInFlight = true;
    try {
      const projected = await projectDesktopRuntime(baseline, Date.now());
      if (!this.running || this.inFlight || this.rawLastScan !== baseline) return;
      const changed = desktopProjectionChanged(this.lastScan, projected);
      const alerts = this.tracker.observeDesktopCompletions(
        projected, recentDesktopCompletions(), this.startedAt, Date.now());
      if (!changed && !alerts.length) return;
      this.lastScan = projected;
      if (alerts.length) this.persistAlerts();
      this.onChange(this.state());
      if (!this.tracker.getMuted()) for (const alert of alerts) this.onAlert(alert);
    } catch {
      // A locked/rotating Desktop log is not a reason to stop other monitoring.
    } finally {
      this.nativeAuditInFlight = false;
    }
  }

  /** Watch-connected machines need only a periodic 60-second audit; disconnected
   * machines keep the original 12-second safety net. */
  private pollFallback(): void {
    if (!this.running) return;
    if (!this.lastScan || Date.now() - this.lastFullScanAt >= HEALTHY_CHANNEL_AUDIT_MS) {
      void this.refresh().catch(error => console.warn('Codex full fallback failed:', error));
      return;
    }
    const modes = this.watchers.status();
    const due = this.lastScan.sources.filter(source =>
      modes[source.id] !== 'active' &&
      Date.now() - (this.lastSourceScan.get(source.id) ?? this.lastFullScanAt) >= POLLING_FALLBACK_MS
    ).map(source => source.id);
    if (due.length) {
      void this.refresh(true, new Set(due)).catch(error =>
        console.warn('Codex per-source fallback failed:', error));
    }
  }

  private queueSource(id: string): void {
    if (!this.running) return;
    this.pendingSources.add(id);
    this.scheduleWake();
  }

  private scheduleWake(): void {
    if (!this.running || this.wakeTimer || !this.pendingSources.size || this.inFlight) return;
    const now = Date.now();
    const wait = Math.max(EVENT_DEBOUNCE_MS, Math.min(...[...this.pendingSources].map(id =>
      Math.max(0, MIN_SOURCE_SCAN_GAP_MS - (now - (this.lastEventScan.get(id) ?? 0))))));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.flushWakes();
    }, wait);
  }

  private flushWakes(): void {
    if (!this.running || this.inFlight) return;
    const now = Date.now();
    const due = new Set<string>();
    for (const id of this.pendingSources) {
      if (now - (this.lastEventScan.get(id) ?? 0) >= MIN_SOURCE_SCAN_GAP_MS) due.add(id);
    }
    if (!due.size) { this.scheduleWake(); return; }
    for (const id of due) {
      this.pendingSources.delete(id);
      this.lastEventScan.set(id, now);
    }
    // Partial scans touch only affected sources. Wake events arriving during an
    // in-flight scan stay queued and get a trailing scan after it finishes.
    void this.refresh(true, due).catch(error =>
      console.warn('Event-triggered Codex scan failed; polling remains active:', error));
    if (this.pendingSources.size) this.scheduleWake();
  }

  /** Manual and fallback scans are full; a watcher provides affected source IDs. */
  refresh(force = false, sourceIds?: ReadonlySet<string>): Promise<ScanResponse> {
    if (this.inFlight) {
      if (sourceIds) for (const id of sourceIds) this.pendingSources.add(id);
      else if (!this.scanningFull && (force ||
        Date.now() - this.lastFullScanAt >= MIN_FULL_SCAN_GAP_MS)) this.needsFullScan = true;
      return this.inFlight;
    }
    const partial = !!sourceIds?.size && !!this.lastScan;
    if (!partial && !force && this.lastScan &&
      Date.now() - this.lastFullScanAt < MIN_FULL_SCAN_GAP_MS) {
      return Promise.resolve(this.lastScan);
    }

    this.scanningFull = !partial;
    const scanStartedAt = performance.now();
    const task = (async () => {
      const settings = await readSettings();
      const delta = await collect(settings, partial ? sourceIds : undefined,
        pinnedRolloutsBySource(this.lastScan));
      if (delta.sources.length === 0 && partial && this.lastScan) return this.lastScan;
      // Use only freshly scanned sources for auto-window correlation: merging cached
      // sources would shift remote-clock ages and could create false associations.
      try { this.onScanned(delta); }
      catch { console.warn('Automatic original-window correlation failed; scan continues'); }

      // Retain a raw baseline independent of the GUI log overlay. This is
      // essential when Desktop's turn/start disappears from log tail or a newer
      // completion supersedes it without any change to a remote JSONL file.
      const raw = partial && this.rawLastScan
        ? mergeSourceSnapshots(this.rawLastScan, delta) : delta;
      const projected = await projectDesktopRuntime(raw, Date.now());
      this.rawLastScan = raw;
      this.lastScan = projected;
      this.lastSourceScanDurationMs = Math.max(0, Math.round(performance.now() - scanStartedAt));

      // Notify from genuinely rescanned sources only. The four-second
      // log-only overlay updates the board but must not fabricate alerts.
      const rescanned = new Set(delta.sources.map(source => source.id));
      const projectedDelta: ScanResponse = {
        ...delta, sources: projected.sources.filter(source => rescanned.has(source.id)),
      };
      for (const source of delta.sources) this.lastSourceScan.set(source.id, delta.scannedAt);
      const alerts = this.tracker.observe(projectedDelta);
      // Only an actual new alert changes the persisted inbox here. Frequent
      // no-change filesystem scans must not serialize the same 500 IDs.
      if (alerts.length) this.persistAlerts();
      if (!partial) {
        this.lastFullScanAt = delta.scannedAt;
        if (this.eventsEnabled) this.watchers.reconcile(settings, delta.sources);
      }
      this.onChange(this.state());
      if (!this.tracker.getMuted()) for (const alert of alerts) this.onAlert(alert);
      return this.lastScan;
    })();

    this.inFlight = task;
    void task.finally(() => {
      if (this.inFlight === task) this.inFlight = null;
      this.scanningFull = false;
      if (!this.running) return;
      if (this.needsFullScan) {
        this.needsFullScan = false;
        void this.refresh(true).catch(error => console.warn('Queued full scan failed:', error));
      } else if (this.pendingSources.size) {
        this.scheduleWake();
      }
    }).catch(() => undefined);
    return task;
  }
}
