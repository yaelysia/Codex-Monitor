import { AlertTracker } from '../src/shared/alert-tracker';
import type { MonitorAlert, MonitorState, ScanResponse } from '../src/shared/types';
import { readSettings } from './config';
import { refresh as collect } from './collector';
import { WatchCoordinator } from './watchers';

const POLLING_FALLBACK_MS = 12_000;
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
  private watchers = new WatchCoordinator(sourceId => this.queueSource(sourceId));
  private pendingSources = new Set<string>();
  private lastEventScan = new Map<string, number>();
  private needsFullScan = false;
  private running = false;

  constructor(
    private readonly onChange: (state: MonitorState) => void,
    private readonly onAlert: (alert: MonitorAlert) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.watchers.start();
    this.timer = setInterval(() => {
      void this.refresh().catch(error => console.warn('Codex fallback scan failed:', error));
    }, POLLING_FALLBACK_MS);
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

  state(): MonitorState { return this.tracker.state(this.lastScan); }
  setMuted(muted: boolean): MonitorState {
    this.tracker.setMuted(muted);
    this.onChange(this.state());
    return this.state();
  }
  acknowledge(id: string): MonitorState {
    this.tracker.acknowledge(id);
    this.onChange(this.state());
    return this.state();
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
      else if (force) this.needsFullScan = true;
      return this.inFlight;
    }
    const partial = !!sourceIds?.size && !!this.lastScan;
    if (!partial && !force && this.lastScan &&
      Date.now() - this.lastScan.scannedAt < MIN_FULL_SCAN_GAP_MS) {
      return Promise.resolve(this.lastScan);
    }

    const task = (async () => {
      const settings = await readSettings();
      const delta = await collect(settings, partial ? sourceIds : undefined);
      if (delta.sources.length === 0 && partial && this.lastScan) return this.lastScan;

      // Notify from only the genuinely rescanned sources. Marking unchanged,
      // cached sources as freshly scanned could fabricate transitions.
      const alerts = this.tracker.observe(delta);
      if (partial && this.lastScan) {
        const updated = new Map(delta.sources.map(source => [source.id, source]));
        this.lastScan = {
          scannedAt: delta.scannedAt,
          sources: [
            ...this.lastScan.sources.map(source => updated.get(source.id) ?? source),
            ...delta.sources.filter(source =>
              !this.lastScan?.sources.some(previous => previous.id === source.id)),
          ],
        };
      } else {
        this.lastScan = delta;
        this.watchers.reconcile(settings, delta.sources);
      }
      this.onChange(this.state());
      if (!this.tracker.getMuted()) for (const alert of alerts) this.onAlert(alert);
      return this.lastScan;
    })();

    this.inFlight = task;
    void task.finally(() => {
      if (this.inFlight === task) this.inFlight = null;
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
