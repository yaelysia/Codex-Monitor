import { AlertTracker } from '../src/shared/alert-tracker';
import type { MonitorAlert, MonitorState, ScanResponse } from '../src/shared/types';
import { readSettings } from './config';
import { refresh as collect } from './collector';

const SCAN_INTERVAL_MS = 12_000;
const MIN_SCAN_GAP_MS = 9_000;

/** Central polling service: only one scan runs for all renderer windows. */
export class MonitorService {
  private tracker = new AlertTracker();
  private lastScan: ScanResponse | null = null;
  private inFlight: Promise<ScanResponse> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (state: MonitorState) => void,
    private readonly onAlert: (alert: MonitorAlert) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh().catch(console.error), SCAN_INTERVAL_MS);
    void this.refresh().catch(console.error);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
  refresh(force = false): Promise<ScanResponse> {
    if (this.inFlight) return this.inFlight;
    if (!force && this.lastScan && Date.now() - this.lastScan.scannedAt < MIN_SCAN_GAP_MS) {
      return Promise.resolve(this.lastScan);
    }
    const task = (async () => {
      const scan = await collect(await readSettings());
      this.lastScan = scan;
      const alerts = this.tracker.observe(scan);
      this.onChange(this.state());
      if (!this.tracker.getMuted()) for (const alert of alerts) this.onAlert(alert);
      return scan;
    })();
    this.inFlight = task;
    void task.finally(() => { if (this.inFlight === task) this.inFlight = null; }).catch(() => undefined);
    return task;
  }
}
