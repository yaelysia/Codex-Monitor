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
export interface PersistedWindowBinding {
  sessionKey: string;
  /** Only native window metadata; never a title, path, prompt or credential. */
  window: OriginalWindow;
  /** Persisted user-input event timestamp for avoiding stale re-associations. */
  inputToken: number;
  savedAt: number;
}
const MAX_BINDINGS = 200;
const MAX_BINDING_AGE_MS = 30 * 24 * 60 * 60_000;
const SAFE_SESSION_KEY = /^[^\s\u0000-\u001f]{1,350}$/;

export function normalizeSavedWindowBinding(raw: unknown, now = Date.now()): PersistedWindowBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.sessionKey !== 'string' || !SAFE_SESSION_KEY.test(data.sessionKey) ||
      !data.sessionKey.includes(':')) return null;
  const window = normalizeForegroundWindow(data.window);
  if (!window || window.app === 'other') return null;
  const inputAt = (data.window as Record<string, unknown>).inputAt;
  if (typeof inputAt !== 'number' || !Number.isSafeInteger(inputAt) ||
      inputAt <= 0) return null;
  const token = data.inputToken;
  const savedAt = data.savedAt;
  if (typeof token !== 'number' || !Number.isFinite(token) ||
      typeof savedAt !== 'number' || !Number.isFinite(savedAt) ||
      savedAt > now + 60_000 || now - savedAt > MAX_BINDING_AGE_MS ||
      savedAt < 0) return null;
  return { sessionKey: data.sessionKey, window: { ...window, inputAt },
    inputToken: token, savedAt };
}

const WINDOW_HISTORY_MS = 5 * 60_000;
const MAX_INPUT_AGE_MS = 45_000;
const MAX_SAMPLES = 4096;
const HEX_HANDLE = /^0x[0-9a-f]{1,16}$/i;
const TAB_TOKEN = /^(?:rid:-?\d+(?:\.-?\d+){0,19}|msaa:[0-9a-f]{32})$/;

/** Keep trustworthy HWND/PID evidence even if optional UIA details are
 * malformed or unsupported. A bad tab ID must never break window binding.
 */
export function normalizeForegroundWindow(value: unknown): ForegroundWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = { ...(value as Record<string, unknown>) };
  if (item.tabId != null && (typeof item.tabId !== 'string' ||
      item.tabId.length > 192 || !TAB_TOKEN.test(item.tabId))) delete item.tabId;
  if (item.tabCount !== undefined &&
      (typeof item.tabCount !== 'number' || !Number.isInteger(item.tabCount) ||
       item.tabCount < 0 || item.tabCount > 1000)) delete item.tabCount;
  if (item.tabHost !== undefined &&
      !['single', 'multi', 'unknown'].includes(String(item.tabHost))) delete item.tabHost;
  return validForegroundWindow(item) ? item : null;
}

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

  observeScan(scan: ScanResponse, now = Date.now()): string[] {
    if (!this.history.length) return [];
    const changed: string[] = [];
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
        const latestInputAt = captureEnd - age;
        // Windows and WSL share the host clock. When the actual persisted user
        // event timestamp fits the bounded scan observation (with tiny skew),
        // it is more precise than the collector's completion time. Otherwise
        // retain the conservative interval to avoid remote-clock misbindings.
        const exact = session.lastUserInputAtSourceMs;
        const canUseExact = (source.kind === 'local' || source.kind === 'wsl') &&
          typeof exact === 'number' && Number.isFinite(exact) &&
          exact >= earliestInputAt - 2000 && exact <= latestInputAt + 2000 &&
          exact <= now + 1000 && now - exact <= MAX_INPUT_AGE_MS;
        const matchStart = canUseExact ? exact : earliestInputAt;
        const inputAt = canUseExact ? exact : latestInputAt;
        if (matchStart < this.history[0]!.at || inputAt > now + 1000 ||
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
        const earliest = foregroundAt(matchStart);
        const selected = foregroundAt(inputAt);
        if (!earliest || !selected || selected.app === 'other' ||
            !isClientMatch(client, selected.app)) continue;
        const sameWindow = (item: ForegroundWindow): boolean =>
          item.hwnd === selected.hwnd && item.pid === selected.pid &&
          item.startedAt === selected.startedAt && item.app === selected.app;
        // Checking endpoints alone is insufficient: a user could leave a window,
        // type in another tab, then return before the remote scan completes.
        const during = this.history.filter(item =>
          item.at >= matchStart && item.at <= inputAt);
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
        changed.push(session.key);
      }
    }
    return changed;
  }

  /** Only import bounded, structurally valid metadata. The HWND identity must
   * still be checked by the native focus action before activating anything.
   */
  restoreBindings(input: readonly unknown[], now = Date.now()): string[] {
    const accepted: PersistedWindowBinding[] = [];
    for (const value of input.slice(0, MAX_BINDINGS * 2)) {
      const record = normalizeSavedWindowBinding(value, now);
      if (record) accepted.push(record);
    }
    accepted.sort((a, b) => a.savedAt - b.savedAt);
    const keys: string[] = [];
    for (const entry of accepted.slice(-MAX_BINDINGS)) {
      const old = this.bindings.get(entry.sessionKey);
      if (old && old.inputAt > entry.window.inputAt) continue;
      this.bindings.set(entry.sessionKey, { ...entry.window });
      this.lastInput.set(entry.sessionKey, entry.inputToken);
      keys.push(entry.sessionKey);
    }
    return keys;
  }

  savedBindings(now = Date.now()): PersistedWindowBinding[] {
    const values: PersistedWindowBinding[] = [];
    for (const [sessionKey, window] of this.bindings) {
      const item = normalizeSavedWindowBinding({
        sessionKey, window, savedAt: window.inputAt,
        inputToken: this.lastInput.get(sessionKey) ?? window.inputAt,
      }, now);
      if (item) values.push(item);
    }
    return values.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_BINDINGS);
  }

  get(sessionKey: string): OriginalWindow | null {
    return this.bindings.get(sessionKey) ?? null;
  }

  invalidate(sessionKey: string): void { this.bindings.delete(sessionKey); }
  /** A broken native watcher cannot justify any correlation across its blind gap.
   * Existing session→HWND mappings remain safe for read-only native revalidation.
   */
  resetObservationHistory(): void { this.history = []; }
  clear(): void { this.history = []; this.bindings.clear(); this.lastInput.clear(); }
}
