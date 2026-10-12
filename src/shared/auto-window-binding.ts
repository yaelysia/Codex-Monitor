import type { ScanResponse, SessionClientKind } from './types';

export type WindowApp = 'desktop' | 'vscode' | 'terminal' | 'other';
export interface ForegroundWindow {
  at: number;
  hwnd: string;
  pid: number;
  startedAt: number;
  app: WindowApp;
}
export type OriginalWindow = ForegroundWindow & { inputAt: number };

const WINDOW_HISTORY_MS = 5 * 60_000;
const MAX_INPUT_AGE_MS = 45_000;
const MAX_SAMPLES = 4096;
const HEX_HANDLE = /^0x[0-9a-f]{1,16}$/i;

export function validForegroundWindow(value: unknown): value is ForegroundWindow {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
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
        const client = session.clientKind ?? 'unknown';
        const age = session.lastUserInputAgeAtSourceMs;
        if (client === 'unknown' || typeof age !== 'number' || !Number.isFinite(age) ||
          age < 0 || age > MAX_INPUT_AGE_MS) continue;
        const inputAt = scan.scannedAt - age;
        if (inputAt < this.history[0]!.at || inputAt > now + 1000 ||
            now - inputAt > MAX_INPUT_AGE_MS) continue;
        const previous = this.lastInput.get(session.key);
        if (previous != null && Math.abs(inputAt - previous) < 1500) continue;

        let selected: ForegroundWindow | undefined;
        for (let j = this.history.length - 1; j >= 0; j--) {
          const item = this.history[j]!;
          if (item.at <= inputAt) { selected = item; break; }
        }
        if (!selected || selected.app === 'other' || !isClientMatch(client, selected.app)) {
          // Do not replace an existing link with a guessed candidate.
          continue;
        }
        this.bindings.set(session.key, { ...selected, inputAt });
        this.lastInput.set(session.key, inputAt);
      }
    }
  }

  get(sessionKey: string): OriginalWindow | null {
    return this.bindings.get(sessionKey) ?? null;
  }

  invalidate(sessionKey: string): void { this.bindings.delete(sessionKey); }
  clear(): void { this.history = []; this.bindings.clear(); this.lastInput.clear(); }
}
