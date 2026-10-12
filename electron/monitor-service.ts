import { AlertTracker } from '../src/shared/alert-tracker';
import type { MonitorAlert, MonitorState, ScanResponse } from '../src/shared/types';
import { readSettings } from './config';
import { refresh as collect } from './collector';
import { WatchCoordinator } from './watchers';
import { mergeSourceSnapshots } from '../src/shared/scan-merge';

const POLLING_FALLBACK_MS = 12_000;
const HEALTHY_CHANNEL_AUDIT_MS = 60_000;
const MIN_FULL_SCAN_GAP_MS = 9_000;
const EVENT_DEBOUNCE_MS = 400;
const MIN_SOURCE_SCAN_GAP_MS = 3_000;

/** One state owner and event queue for all renderer windows and external hosts. */
export class MonitorService {
  private tracker = new AlertTracker();
  private lastScan: ScanResponse | null = null;
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

  constructor(
    private readonly onChange: (state: MonitorState) => void,
    private readonly onAlert: (alert: MonitorAlert) => void,
    private readonly onScanned: (delta: ScanResponse) => void = () => {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.eventsEnabled) this.watchers.start();
    this.timer = setInterval(() => this.pollFallback(), POLLING_FALLBACK_MS);
    void this.refresh().catch(error => console.warn('Initial Codex scan failed:', error));
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.pendingSources.clear();
    this.watchers.stop();
  }

  state(): MonitorState { return { ...this.tracker.state(this.lastScan), eventChannels: this.watchers.status() }; }
  setMuted(muted: boolean): MonitorState {
    this.tracker.setMuted(muted);
    this.onChange(this.state());
    return this.state();
  }
  acknowledge(id: string): MonitorState { return this.acknowledgeMany([id]); }
  acknowledgeMany(ids: readonly string[]): MonitorState {
    if (!ids.length) return this.state();
    this.tracker.acknowledgeMany(ids);
    this.onChange(this.state());
    return this.state();
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
      (modes[source.id] !== 'active' ||
        // Desktop's GUI-owned status logs can change without any JSONL file
        // event. Audit local Desktop threads every 12s despite a healthy
        // sessions watcher; leave SSH/WSL scheduling unchanged.
        (source.kind === 'local' && source.sessions.some(row =>
          row.clientKind === 'desktop'))) &&
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
    const task = (async () => {
      const settings = await readSettings();
      const delta = await collect(settings, partial ? sourceIds : undefined);
      if (delta.sources.length === 0 && partial && this.lastScan) return this.lastScan;
      // Use only freshly scanned sources for auto-window correlation: merging cached
      // sources would shift remote-clock ages and could create false associations.
      try { this.onScanned(delta); }
      catch { console.warn('Automatic original-window correlation failed; scan continues'); }

      // Notify from only the genuinely rescanned sources. Marking unchanged,
      // cached sources as freshly scanned could fabricate transitions.
      for (const source of delta.sources) this.lastSourceScan.set(source.id, delta.scannedAt);
      const alerts = this.tracker.observe(delta);
      if (partial && this.lastScan) {
        this.lastScan = mergeSourceSnapshots(this.lastScan, delta);
      } else {
        this.lastScan = delta;
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
