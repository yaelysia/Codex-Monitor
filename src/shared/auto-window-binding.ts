import type { ScanResponse, SessionClientKind } from './types';

export type WindowApp = 'desktop' | 'vscode' | 'terminal' | 'other';
export interface ForegroundWindow {
  at: number;
  hwnd: string;
  pid: number;
  startedAt: number;
  app: WindowApp;
  /** Ephemeral UI Automation runtime identity; neither title nor tab index. */
  tabId?: string | null;
  /** Number of UIA tab items observed; zero means unknown/unsupported. */
  tabCount?: number;
  /** Multi-tab terminal may be opaque to UI Automation. */
  tabHost?: 'single' | 'multi' | 'unknown';
}
export type OriginalWindow = ForegroundWindow & { inputAt: number };

const WINDOW_HISTORY_MS = 5 * 60_000;
const MAX_INPUT_AGE_MS = 45_000;
const MAX_SAMPLES = 4096;
const HEX_HANDLE = /^0x[0-9a-f]{1,16}$/i;
const TAB_TOKEN = /^rid:-?\d+(?:\.-?\d+){0,19}$/;

export function validForegroundWindow(value: unknown): value is ForegroundWindow {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (item.tabHost !== undefined &&
      !['single', 'multi', 'unknown'].includes(String(item.tabHost))) return false;
  if (item.tabCount !== undefined &&
      (typeof item.tabCount !== 'number' || !Number.isInteger(item.tabCount) ||
       item.tabCount < 0 || item.tabCount > 1000)) return false;
  if (item.tabId != null && (typeof item.tabId !== 'string' ||
      item.tabId.length > 192 || !TAB_TOKEN.test(item.tabId))) return false;
  if (item.app === 'other' && item.hwnd === '0x0' &&
    item.pid === 0 && item.startedAt === 0) {
    return typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0;
  }
  return typeof item.at === 'number' && Number.isFinite(item.at) && item.at > 0 &&
    typeof item.hwnd === 'string' && HEX_HANDLE.test(item.hwnd) &&
    typeof item.pid === 'number' && Number.isSafeInteger(item.pid) && item.pid > 0 &&
    typeof item.startedAt === 'number' && Number.isSafeInteger(item.startedAt) &&
    item.startedAt > 0 && ['desktop', 'vscode', 'terminal', 'other'].includes(String(item.app));
}

function isClientMatch(client: SessionClientKind, app: WindowApp): boolean {
  return client === app || (client === 'terminal' && app === 'vscode');
}

/** Associate an input with whichever visible app was foreground at that moment.
 * No title, prompt, directory, screen capture or process command line is used.
 * This does NOT prove which tab/pane was active within a host window.
 */
export class AutoWindowResolver {
  private history: ForegroundWindow[] = [];
  private bindings = new Map<string, OriginalWindow>();
  private lastInput = new Map<string, number>();

  observeFocus(sample: ForegroundWindow): void {
    if (!validForegroundWindow(sample)) return;
    // Ignore reordered events; WinEventHook emits monotonically on its message thread.
    if (this.history.length && sample.at < this.history[this.history.length - 1]!.at) return;
    this.history.push(sample);
    const minTime = sample.at - WINDOW_HISTORY_MS;
    while (this.history.length > 1 && this.history[0]!.at < minTime) this.history.shift();
    if (this.history.length > MAX_SAMPLES) this.history.splice(0, this.history.length - MAX_SAMPLES);
  }

  observeScan(scan: ScanResponse, now = Date.now()): void {
    if (!this.history.length) return;
    for (const source of scan.sources) {
      if (source.error) continue;
      for (const session of source.sessions) {
        if (session.isSubagent) continue;
        const client = session.clientKind ?? 'unknown';
        const age = session.lastUserInputAgeAtSourceMs;
        if (client === 'unknown' || typeof age !== 'number' || !Number.isFinite(age) ||
          age < 0 || age > MAX_INPUT_AGE_MS) continue;
        const captureEnd = source.capturedAt ?? scan.scannedAt;
        const captureStart = source.captureStartedAt ?? captureEnd;
        const earliestInputAt = captureStart - age;
        const inputAt = captureEnd - age;
        if (earliestInputAt < this.history[0]!.at || inputAt > now + 1000 ||
            captureStart > captureEnd || now - inputAt > MAX_INPUT_AGE_MS) continue;
        const token = session.lastUserInputAtSourceMs ?? inputAt;
        const previous = this.lastInput.get(session.key);
        if (previous != null && (previous === token ||
            (session.lastUserInputAtSourceMs == null && Math.abs(inputAt - previous) < 1500))) continue;

        const foregroundAt = (time: number): ForegroundWindow | undefined => {
          for (let j = this.history.length - 1; j >= 0; j--) {
            const item = this.history[j]!;
            if (item.at <= time) return item;
          }
          return undefined;
        };
        const earliest = foregroundAt(earliestInputAt);
        const selected = foregroundAt(inputAt);
        if (!earliest || !selected || selected.app === 'other' ||
            !isClientMatch(client, selected.app)) continue;
        const sameWindow = (item: ForegroundWindow): boolean =>
          item.hwnd === selected.hwnd && item.pid === selected.pid &&
          item.startedAt === selected.startedAt && item.app === selected.app;
        // Checking endpoints alone is insufficient: a user could leave a window,
        // type in another tab, then return before the remote scan completes.
        const during = this.history.filter(item =>
          item.at >= earliestInputAt && item.at <= inputAt);
        if (!sameWindow(earliest) || during.some(item => !sameWindow(item))) continue;
        // A tab identity requires continuity across every observed sample,
        // including a post-input sample. A partial/ambiguous provider is a
        // WINDOW-only match and must not be described as exact-tab navigation.
        const confirmedAfter = this.history.find(item =>
          item.at > inputAt && item.at <= inputAt + 3000);
        const tabConfirmed = !!selected.tabId && sameWindow(earliest) &&
          earliest.tabId === selected.tabId &&
          during.every(item => item.tabId === selected.tabId) &&
          !!confirmedAfter && sameWindow(confirmedAfter) &&
          confirmedAfter.tabId === selected.tabId;
        this.bindings.set(session.key, {
          ...selected, inputAt,
          tabId: tabConfirmed ? selected.tabId : null,
          tabCount: Math.max(earliest.tabCount ?? 0, selected.tabCount ?? 0,
            confirmedAfter?.tabCount ?? 0),
        });
        this.lastInput.set(session.key, token);
      }
    }
  }

  get(sessionKey: string): OriginalWindow | null {
    return this.bindings.get(sessionKey) ?? null;
  }

  invalidate(sessionKey: string): void { this.bindings.delete(sessionKey); }
  clear(): void { this.history = []; this.bindings.clear(); this.lastInput.clear(); }
}
