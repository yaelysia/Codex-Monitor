import { AlertTracker } from '../src/shared/alert-tracker';
import type { MonitorAlert, MonitorState, ScanResponse } from '../src/shared/types';
import { readSettings } from './config';
import { refresh as collect, projectDesktopRuntime, recentDesktopCompletions } from './collector';
import { WatchCoordinator } from './watchers';
import { mergeSourceSnapshots } from '../src/shared/scan-merge';
import { AlertStateStore } from './alert-store';
import { getDesktopLogMetrics, getDesktopLogWatchDirectories } from './desktop-runtime-logs';
import { DesktopLogFolderWatcher } from './desktop-log-watch';
import { pinnedRolloutsBySource } from '../src/shared/pinned-rollouts';
import { SourceRetention } from '../src/shared/source-retention';
import { NotificationPerformance } from '../src/shared/notification-performance';
import type { SourceResult, AlertKind } from '../src/shared/types';

const POLLING_FALLBACK_MS = 12_000;
const HEALTHY_CHANNEL_AUDIT_MS = 60_000;
const MIN_FULL_SCAN_GAP_MS = 9_000;
const EVENT_DEBOUNCE_MS = 400;
const MIN_SOURCE_SCAN_GAP_MS = 3_000;
// Bounded log-only audits are independent from expensive WSL/SSH metadata scans.
const DESKTOP_NATIVE_AUDIT_MS = 4_000;
const DESKTOP_WATCH_FALLBACK_MS = 12_000;
const DESKTOP_EVENT_GAP_MS = 2_000;

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
  private readonly sourceRetention = new SourceRetention();
  private readonly notificationPerformance = new NotificationPerformance();
  private readonly alertStore: AlertStateStore | null;
  private lastSourceScanDurationMs: number | null = null;
  private lastScan: ScanResponse | null = null;
  private rawLastScan: ScanResponse | null = null;
  private scanRevision = 0;
  private nativeAuditTimer: ReturnType<typeof setInterval> | null = null;
  private nativeAuditInFlight = false;
  private lastNativeAuditAt = 0;
  private desktopWakeTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeWakePending = false;
  private readonly desktopLogWatcher = new DesktopLogFolderWatcher(
    () => this.queueDesktopAudit());
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
    this.lastNativeAuditAt = this.startedAt;
    if (this.eventsEnabled) this.watchers.start();
    this.timer = setInterval(() => this.pollFallback(), POLLING_FALLBACK_MS);
    if (this.platform === 'win32' &&
        process.env.CODEX_MONITOR_DISABLE_DESKTOP_LOGS !== '1') {
      this.nativeAuditTimer = setInterval(() => {
        // Keep the old four-second safety net when fs.watch has no complete
        // coverage. With event coverage, use a 12s audit to recover lost events.
        const due = this.desktopLogWatcher.healthy
          ? DESKTOP_WATCH_FALLBACK_MS : DESKTOP_NATIVE_AUDIT_MS;
        if (Date.now() - this.lastNativeAuditAt >= due)
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
    if (this.desktopWakeTimer) clearTimeout(this.desktopWakeTimer);
    this.desktopWakeTimer = null;
    this.nativeWakePending = false;
    this.desktopLogWatcher.close();
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.pendingSources.clear();
    this.watchers.stop();
    this.persistAlerts();
    this.alertStore?.flush();
  }

  state(): MonitorState {
    return {
      ...this.tracker.state(this.lastScan), scanRevision: this.scanRevision,
      eventChannels: this.watchers.status(),
      performance: {
        sourceScanDurationMs: this.lastSourceScanDurationMs,
        desktopAudit: this.platform === 'win32' ? getDesktopLogMetrics() : null,
        notificationLag: this.notificationPerformance.snapshot(),
      },
    };
  }
  setMuted(muted: boolean): MonitorState {
    this.tracker.setMuted(muted);
    this.persistAlerts();
    this.onChange(this.state());
    return this.state();
  }
  /** Update one kind atomically: rapid UI toggles cannot overwrite each other. */
  setNotificationKindEnabled(kind: AlertKind, enabled: boolean): MonitorState {
    this.tracker.setNotificationKindEnabled(kind, enabled);
    this.persistAlerts();
    this.onChange(this.state());
    return this.state();
  }
  /** Used by the existing native foreground hook; no work is done when there
   * are no unread alerts associated with the verified original session.
   */
  unreadSessionKeys(): string[] { return this.tracker.unreadSessionKeys(); }
  acknowledgeSessionAlerts(sessionKey: string): number {
    const ids = this.tracker.unreadSessionAlertIds(sessionKey);
    if (!ids.length) return 0;
    this.acknowledgeMany(ids);
    return ids.length;
  }

  acknowledge(id: string): MonitorState { return this.acknowledgeMany([id]); }
  acknowledgeMany(ids: readonly string[]): MonitorState {
    if (!ids.length) return this.state();
    this.tracker.acknowledgeMany(ids);
    this.persistAlerts();
    this.onChange(this.state());
    return this.state();
  }

  private queueDesktopAudit(): void {
    if (!this.running) return;
    this.nativeWakePending = true;
    if (this.desktopWakeTimer) return;
    const delay = Math.max(250, DESKTOP_EVENT_GAP_MS -
      Math.max(0, Date.now() - this.lastNativeAuditAt));
    this.desktopWakeTimer = setTimeout(() => {
      this.desktopWakeTimer = null;
      if (!this.running || this.nativeAuditInFlight || this.inFlight) return;
      this.nativeWakePending = false;
      void this.auditDesktopRuntime();
    }, delay);
    this.desktopWakeTimer.unref?.();
  }

  /** Native status can update a known local/WSL/SSH session without waiting
   * for a new JSONL write or rescanning a slow remote filesystem.
   * The raw filesystem snapshot remains immutable; overlay can be removed or
   * superseded by newer native completion evidence on the next tick.
   */
  private async auditDesktopRuntime(): Promise<void> {
    const baseline = this.rawLastScan;
    if (!this.running || !baseline) return;
    if (this.inFlight || this.nativeAuditInFlight) {
      this.nativeWakePending = true;
      return;
    }
    this.nativeAuditInFlight = true;
    this.lastNativeAuditAt = Date.now();
    try {
      const projected = await projectDesktopRuntime(baseline, Date.now());
      if (this.running && this.eventsEnabled) this.desktopLogWatcher.reconcile(
        getDesktopLogWatchDirectories());
      if (!this.running || this.inFlight || this.rawLastScan !== baseline) return;
      const changed = desktopProjectionChanged(this.lastScan, projected);
      const alerts = this.tracker.observeDesktopCompletions(
        projected, recentDesktopCompletions(), this.startedAt, Date.now());
      if (!changed && !alerts.length) return;
      this.lastScan = projected;
      if (changed) this.scanRevision++;
      if (alerts.length) this.persistAlerts();
      this.onChange(this.state());
      if (!this.tracker.getMuted()) for (const alert of alerts)
        if (!alert.read) this.onAlert(alert);
    } catch {
      // A locked/rotating Desktop log is not a reason to stop other monitoring.
    } finally {
      this.nativeAuditInFlight = false;
      if (this.running && this.nativeWakePending) this.queueDesktopAudit();
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

  /** Apply only the sources whose scan actually finished. This never advances
   * alert history for cached/unscanned sources, even during a full refresh.
   */
  private async acceptSources(sources: SourceResult[], scannedAt: number): Promise<void> {
    if (!sources.length) return;
    const rawDelta: ScanResponse = { scannedAt, sources };
    try { this.onScanned(rawDelta); }
    catch { console.warn('Automatic original-window correlation failed; scan continues'); }

    const recovered: ScanResponse = {
      scannedAt, sources: sources.map(source =>
        this.sourceRetention.onFailure(source, Date.now())),
    };
    const raw = this.rawLastScan
      ? mergeSourceSnapshots(this.rawLastScan, recovered) : recovered;
    // Native GUI evidence must be projected on the whole known source scope.
    // This retains exact-thread matching and current native completion safety.
    const projected = await projectDesktopRuntime(raw, Date.now());
    const affected = new Set(sources.map(source => source.id));
    const justScanned = projected.sources.filter(source => affected.has(source.id));
    this.rawLastScan = raw;
    this.lastScan = projected;
    this.scanRevision++;
    for (const source of justScanned) {
      if (!source.error) this.sourceRetention.remember(source, Date.now());
      this.lastSourceScan.set(source.id, scannedAt);
    }
    const alerts = this.tracker.observe({ scannedAt, sources: justScanned });
    if (this.running) alerts.push(...this.tracker.observeDesktopCompletions(
      projected, recentDesktopCompletions(), this.startedAt, Date.now()));
    if (alerts.length) {
      this.notificationPerformance.observe(alerts, projected, Date.now());
      this.persistAlerts();
    }
    this.onChange(this.state());
    if (!this.tracker.getMuted()) for (const alert of alerts)
      if (!alert.read) this.onAlert(alert);
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
      const pinSources = this.sourceRetention.pinSnapshot(Date.now());
      const pins = pinnedRolloutsBySource(pinSources.sources.length
        ? pinSources : this.lastScan);

      // The production collector calls onSource when EACH host settles, so
      // notifications and renderer updates do not wait for the slowest SSH.
      // Tests/legacy collectors may return only the aggregate result.
      const observed = new Set<string>();
      let updates: Promise<void> = Promise.resolve();
      const deliver = (sources: SourceResult[], at: number): Promise<void> => {
        updates = updates.then(() => this.acceptSources(sources, at));
        return updates;
      };
      const delta = await collect(settings, partial ? sourceIds : undefined,
        pins, async source => {
          await deliver([source], source.capturedAt ?? Date.now());
          observed.add(source.id);
        }, partial && this.watchers.status().local === 'active');
      if (delta.sources.length === 0 && partial && this.lastScan) return this.lastScan;
      const remainder = delta.sources.filter(source => !observed.has(source.id));
      if (remainder.length) await deliver(remainder, delta.scannedAt);
      await updates;

      // The last full scan establishes the configured source set and original
      // order. Keep the per-host projected status and retained error evidence.
      if (!partial) {
        const order = delta.sources.map(source => source.id);
        const known = new Set(order);
        this.sourceRetention.forgetAbsent(known);
        if (this.tracker.forgetSources(known)) this.persistAlerts();
        const byId = new Map(this.lastScan?.sources.map(src => [src.id, src]) ?? []);
        const rawById = new Map(this.rawLastScan?.sources.map(src => [src.id, src]) ?? []);
        this.lastScan = { scannedAt: delta.scannedAt,
          sources: order.map(id => byId.get(id)!).filter(Boolean) };
        this.rawLastScan = { scannedAt: delta.scannedAt,
          sources: order.map(id => rawById.get(id)!).filter(Boolean) };
        this.scanRevision++;
        this.lastFullScanAt = delta.scannedAt;
        if (this.eventsEnabled) this.watchers.reconcile(settings, delta.sources);
      }
      this.lastSourceScanDurationMs = Math.max(0, Math.round(performance.now() - scanStartedAt));
      this.onChange(this.state());
      return this.lastScan!;
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
      if (this.nativeWakePending) this.queueDesktopAudit();
    }).catch(() => undefined);
    return task;
  }
}
