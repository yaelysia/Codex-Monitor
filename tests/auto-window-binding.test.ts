import { describe, expect, it } from 'vitest';
import { AutoWindowResolver, normalizeForegroundWindow, validForegroundWindow } from '../src/shared/auto-window-binding';
import type { ScanResponse, SessionRecord } from '../src/shared/types';

const NOW = Date.parse('2026-10-12T09:00:00Z');
const sample = (at: number, app: 'terminal' | 'desktop' | 'vscode' | 'other',
  hwnd = '0x1234', pid = 123): { at: number; app: typeof app; hwnd: string; pid: number; startedAt: number } =>
  ({ at, app, hwnd, pid, startedAt: 9000 });
const makeScan = (at: number, age: number, kind: SessionRecord['clientKind'] = 'terminal',
  key = 'ssh:server:thread'): ScanResponse => ({ scannedAt: at, sources: [{
    id: 'ssh:server', kind: 'ssh', label: 'server', error: null, sessions: [{
      key, id: 'thread', sourceId: 'ssh:server', sourceLabel: 'server',
      title: null, workspace: null, status: 'working', statusReason: 'test',
      updatedAt: at, startedAt: null, clientKind: kind, lastUserInputAgeAtSourceMs: age,
    }],
  }] });

describe('automatic original-window matching', () => {
  it('associates a Linux/SSH user input with the foreground host window', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 20_000, 'terminal'));
    resolver.observeFocus(sample(NOW - 1000, 'other', '0x2222', 222));
    resolver.observeFocus(sample(NOW - 400, 'terminal', '0x3333', 333));
    resolver.observeFocus(sample(NOW + 300, 'other', '0x4444', 444));
    resolver.observeScan(makeScan(NOW + 700, 700), NOW + 800);
    expect(resolver.get('ssh:server:thread')).toMatchObject({ hwnd: '0x3333', pid: 333 });
  });

  it('rejects stale input, unsupported client, or focus on the wrong app', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW, 'vscode'));
    resolver.observeScan(makeScan(NOW + 90_000, 90_000), NOW + 90_000);
    resolver.observeScan(makeScan(NOW + 1000, 1000, 'desktop'), NOW + 1000);
    resolver.observeScan(makeScan(NOW + 1000, 1000, 'unknown'), NOW + 1000);
    expect(resolver.get('ssh:server:thread')).toBeNull();
  });

  it('does not accidentally associate an input before tracking began', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW + 1000, 'terminal'));
    resolver.observeScan(makeScan(NOW + 2000, 2000), NOW + 2000);
    expect(resolver.get('ssh:server:thread')).toBeNull();
  });

  it('updates an association after a later input from a different original window', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 1000, 'terminal', '0x1111', 111));
    resolver.observeScan(makeScan(NOW, 100), NOW);
    resolver.observeFocus(sample(NOW + 4000, 'terminal', '0x2222', 222));
    resolver.observeScan(makeScan(NOW + 5000, 500), NOW + 5000);
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x2222');
    resolver.invalidate('ssh:server:thread');
    expect(resolver.get('ssh:server:thread')).toBeNull();
  });

  it('permits the VS Code integrated terminal for a CLI but not Desktop', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 1000, 'vscode'));
    resolver.observeScan(makeScan(NOW, 100), NOW);
    expect(resolver.get('ssh:server:thread')?.app).toBe('vscode');
    const separate = new AutoWindowResolver();
    separate.observeFocus(sample(NOW - 1000, 'vscode'));
    separate.observeScan(makeScan(NOW, 100, 'desktop'), NOW);
    expect(separate.get('ssh:server:thread')).toBeNull();
  });

  it('rejects malformed native evidence to avoid focusing arbitrary HWNDs', () => {
    const resolver = new AutoWindowResolver();
    const malicious = { ...sample(NOW, 'terminal'), hwnd: 'powershell -Command Evil()' };
    expect(validForegroundWindow(malicious)).toBe(false);
    resolver.observeFocus(malicious as any);
    resolver.observeScan(makeScan(NOW + 100, 100), NOW + 100);
    expect(resolver.get('ssh:server:thread')).toBeNull();
  });
});

describe('independent source scan time prevents cross-host misassociation', () => {
  it('does not shift SSH user input timestamps to the last of multiple source scans', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 500, 'terminal', '0x1111', 111));
    resolver.observeFocus(sample(NOW + 5000, 'terminal', '0x2222', 222));
    const scan = makeScan(NOW + 10_000, 500);
    scan.sources[0]!.capturedAt = NOW + 200;
    resolver.observeScan(scan, NOW + 10_000);
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x1111');
  });
});

describe('stable user event deduplication', () => {
  it('does not relink an old user event after another window becomes foreground', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 500, 'terminal', '0x1111', 111));
    const first = makeScan(NOW + 200, 300);
    first.sources[0]!.sessions[0]!.lastUserInputAtSourceMs = 1000000;
    resolver.observeScan(first, NOW + 200);
    resolver.observeFocus(sample(NOW + 3000, 'terminal', '0x2222', 222));
    const next = makeScan(NOW + 5000, 500);
    next.sources[0]!.sessions[0]!.lastUserInputAtSourceMs = 1000000;
    resolver.observeScan(next, NOW + 5000);
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x1111');
  });
});

describe('uncertain remote timing', () => {
  it('avoids binding either of two terminals when focus switched during SSH scanning', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 5000, 'terminal', '0x1111', 111));
    resolver.observeFocus(sample(NOW + 1000, 'terminal', '0x2222', 222));
    const scan = makeScan(NOW + 4000, 2000);
    scan.sources[0]!.captureStartedAt = NOW;
    scan.sources[0]!.capturedAt = NOW + 4000;
    resolver.observeScan(scan, NOW + 4000);
    expect(resolver.get('ssh:server:thread')).toBeNull();
  });

  it('matches when the same window remained foreground for the entire remote scan window', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 5000, 'terminal', '0x1111', 111));
    const scan = makeScan(NOW + 4000, 2000);
    scan.sources[0]!.captureStartedAt = NOW;
    scan.sources[0]!.capturedAt = NOW + 4000;
    resolver.observeScan(scan, NOW + 4000);
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x1111');
  });
});

describe('safe multi-tab identity binding', () => {
  const withTab = (at: number, id: string, hwnd = '0x1234') => ({
    ...sample(at, 'terminal', hwnd), tabId: id, tabCount: 3,
  });

  it('associates a tab when observations before and after input agree', () => {
    const r = new AutoWindowResolver();
    r.observeFocus(withTab(NOW - 5000, 'rid:1.10'));
    r.observeFocus(withTab(NOW - 1000, 'rid:1.10'));
    r.observeFocus(withTab(NOW + 200, 'rid:1.10'));
    r.observeScan(makeScan(NOW + 100, 100), NOW + 300);
    expect(r.get('ssh:server:thread')?.tabId).toBe('rid:1.10');
    expect(r.get('ssh:server:thread')?.tabCount).toBe(3);
  });

  it('preserves the window but never assigns a tab that changed during a scan', () => {
    const r = new AutoWindowResolver();
    r.observeFocus(withTab(NOW - 5000, 'rid:1.10'));
    r.observeFocus(withTab(NOW - 100, 'rid:1.11'));
    r.observeFocus(withTab(NOW + 200, 'rid:1.11'));
    const scan = makeScan(NOW + 100, 100);
    scan.sources[0]!.captureStartedAt = NOW - 2000;
    scan.sources[0]!.capturedAt = NOW + 100;
    r.observeScan(scan, NOW + 300);
    expect(r.get('ssh:server:thread')?.hwnd).toBe('0x1234');
    expect(r.get('ssh:server:thread')?.tabId).toBeNull();
  });

  it('does not assign a selected tab without post-input validation', () => {
    const r = new AutoWindowResolver();
    r.observeFocus(withTab(NOW - 100, 'rid:1.10'));
    r.observeScan(makeScan(NOW + 100, 100), NOW + 300);
    expect(r.get('ssh:server:thread')?.tabCount).toBe(3);
    expect(r.get('ssh:server:thread')?.tabId).toBeNull();
  });

  it('rejects arbitrary or potentially unsafe tab identifiers from native output', () => {
    expect(validForegroundWindow({ ...withTab(NOW, 'rid:1.10'), tabId: '../private' })).toBe(false);
    expect(validForegroundWindow({ ...withTab(NOW, 'rid:1.10'), tabId: 'rid:1.-2.30' })).toBe(true);
    expect(validForegroundWindow({ ...withTab(NOW, 'rid:1.10'), tabCount: -1 })).toBe(false);
  });
});

describe('transient focus or tab changes in the scanning interval', () => {
  it('rejects a window binding if another foreground app appeared and then returned', () => {
    const r = new AutoWindowResolver();
    r.observeFocus(sample(NOW - 5000, 'terminal', '0x1111', 111));
    r.observeFocus(sample(NOW - 1500, 'other', '0x2222', 222));
    r.observeFocus(sample(NOW - 500, 'terminal', '0x1111', 111));
    const scan = makeScan(NOW + 100, 100);
    scan.sources[0]!.captureStartedAt = NOW - 2000;
    scan.sources[0]!.capturedAt = NOW + 100;
    r.observeScan(scan, NOW + 200);
    expect(r.get('ssh:server:thread')).toBeNull();
  });

  it('retains window-only precision after an intermediate tab switch and return', () => {
    const r = new AutoWindowResolver();
    const tab = (at: number, id: string) => ({
      ...sample(at, 'terminal'), tabId: id, tabCount: 4,
    });
    r.observeFocus(tab(NOW - 5000, 'rid:1.10'));
    r.observeFocus(tab(NOW - 1500, 'rid:1.11'));
    r.observeFocus(tab(NOW - 500, 'rid:1.10'));
    r.observeFocus(tab(NOW + 200, 'rid:1.10'));
    const scan = makeScan(NOW + 100, 100);
    scan.sources[0]!.captureStartedAt = NOW - 2000;
    scan.sources[0]!.capturedAt = NOW + 100;
    r.observeScan(scan, NOW + 300);
    expect(r.get('ssh:server:thread')).toMatchObject({ hwnd: '0x1234', tabId: null, tabCount: 4 });
  });
});

describe('multi-tab hosts with inaccessible tab controls', () => {
  it('keeps host classification and refuses to pretend an opaque tab is identified', () => {
    const r = new AutoWindowResolver();
    r.observeFocus({ ...sample(NOW - 500, 'terminal'), tabHost: 'multi', tabCount: 0 });
    r.observeFocus({ ...sample(NOW + 250, 'terminal'), tabHost: 'multi', tabCount: 0 });
    r.observeScan(makeScan(NOW + 100, 100), NOW + 300);
    expect(r.get('ssh:server:thread')).toMatchObject({ tabHost: 'multi', tabId: null, tabCount: 0 });
    expect(validForegroundWindow({ ...sample(NOW, 'terminal'), tabHost: 'invalid' })).toBe(false);
  });
});

describe('UI Automation optional fields must never disable foreground correlation', () => {
  it('strips malformed tab identity but retains original HWND and process evidence', () => {
    const row = { ...sample(NOW, 'terminal'), tabId: 'rid:.3.42',
      tabCount: 3, tabHost: 'multi' };
    expect(validForegroundWindow(row)).toBe(false);
    expect(normalizeForegroundWindow(row)).toMatchObject({
      hwnd: '0x1234', pid: 123, tabCount: 3, tabHost: 'multi',
    });
    expect(normalizeForegroundWindow(row)?.tabId).toBeUndefined();
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(normalizeForegroundWindow({ ...row, at: NOW - 1000 })!);
    resolver.observeScan(makeScan(NOW, 100), NOW);
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x1234');
    expect(resolver.get('ssh:server:thread')?.tabId).toBeNull();
  });

  it('does not accept unsafe HWND or PID even when optional UIA fields are dropped', () => {
    expect(normalizeForegroundWindow({ ...sample(NOW, 'terminal'), hwnd: 'cmd /c whoami',
      tabId: 'rid:.3.42' })).toBeNull();
    expect(normalizeForegroundWindow({ ...sample(NOW, 'vscode'), pid: -1 })).toBeNull();
  });
});

describe('native watch interruption preserves verified original windows', () => {
  it('preserves previously discovered HWND, discards old focus timeline', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 1000, 'terminal'));
    resolver.observeScan(makeScan(NOW, 100), NOW);
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x1234');
    resolver.resetObservationHistory();
    expect(resolver.get('ssh:server:thread')?.hwnd).toBe('0x1234');
    const newScan = makeScan(NOW + 3000, 100, 'terminal', 'ssh:server:new-thread');
    resolver.observeScan(newScan, NOW + 3000);
    expect(resolver.get('ssh:server:new-thread')).toBeNull();
  });
});

describe('prompt submission followed by immediate app switch', () => {
  it('uses a verified local message timestamp instead of wrongly rejecting a slow scan', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 1000, 'vscode', '0x1111', 111));
    resolver.observeFocus(sample(NOW + 300, 'other', '0x2222', 222));
    const snap = makeScan(NOW + 3000, 1000, 'vscode', 'local:thread');
    snap.sources[0]!.kind = 'local';
    snap.sources[0]!.captureStartedAt = NOW - 500;
    snap.sources[0]!.capturedAt = NOW + 3000;
    snap.sources[0]!.sessions[0]!.lastUserInputAtSourceMs = NOW - 200;
    resolver.observeScan(snap, NOW + 3000);
    expect(resolver.get('local:thread')).toMatchObject({
      hwnd: '0x1111', pid: 111,
    });
  });

  it('does not trust an implausible local event timestamp or guess across a window switch', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(sample(NOW - 1000, 'vscode', '0x1111', 111));
    resolver.observeFocus(sample(NOW + 300, 'other', '0x2222', 222));
    const snap = makeScan(NOW + 3000, 1000, 'vscode', 'local:thread');
    snap.sources[0]!.kind = 'local';
    snap.sources[0]!.captureStartedAt = NOW - 500;
    snap.sources[0]!.capturedAt = NOW + 3000;
    snap.sources[0]!.sessions[0]!.lastUserInputAtSourceMs = NOW - 20_000;
    resolver.observeScan(snap, NOW + 3000);
    expect(resolver.get('local:thread')).toBeNull();
  });
});

describe('persisted association normalization', () => {
  it('only restores valid bounded HWND/PID/start metadata and preserves input deduplication', () => {
    const old = new AutoWindowResolver();
    old.observeFocus(sample(NOW - 1000, 'vscode'));
    const snap = makeScan(NOW, 200, 'vscode', 'local:thread');
    snap.sources[0]!.sessions[0]!.lastUserInputAtSourceMs = NOW - 200;
    old.observeScan(snap, NOW);
    const saved = old.savedBindings(NOW + 1000);
    expect(saved).toHaveLength(1);
    const fresh = new AutoWindowResolver();
    expect(fresh.restoreBindings([...saved, { ...saved[0], sessionKey: 'x', window: { hwnd: 'bad' } }],
      NOW + 1000)).toEqual(['local:thread']);
    expect(fresh.get('local:thread')).toMatchObject({ hwnd: '0x1234', pid: 123 });
    fresh.observeFocus(sample(NOW + 3000, 'vscode', '0x9999', 999));
    fresh.observeScan({ ...snap, scannedAt: NOW + 3500, sources: [{
      ...snap.sources[0]!, capturedAt: NOW + 3500,
      sessions: [{ ...snap.sources[0]!.sessions[0]!, lastUserInputAgeAtSourceMs: 500 }],
    }] }, NOW + 3500);
    expect(fresh.get('local:thread')?.hwnd).toBe('0x1234');
  });
});


describe('binding metadata privacy', () => {
  it('drops any unknown/secret properties when normalizing a restored window', () => {
    const time = NOW;
    const entry = {
      sessionKey: 'local:safe-session',
      savedAt: time - 1000, inputToken: time - 1000,
      window: {
        ...sample(time - 1000, 'vscode'),
        inputAt: time - 1000,
        privateKey: 'PRIVATE-SSH-KEY',
        prompt: 'PRIVATE USER PROMPT',
        tabId: 'rid:12.10',
      },
    };
    const r = new AutoWindowResolver();
    r.restoreBindings([entry], time);
    const snapshot = JSON.stringify(r.savedBindings(time));
    expect(snapshot).toContain('rid:12.10');
    expect(snapshot).not.toContain('PRIVATE');
    expect(snapshot).not.toContain('privateKey');
    expect(snapshot).not.toContain('prompt');
  });
});

describe('opaque MobaXterm MSAA tab tokens and saved metadata safety', () => {
  it('preserves only the validated opaque name fingerprint, never a caption', () => {
    const binding = { ...sample(NOW, 'terminal'), tabId: 'msaa:' + 'a'.repeat(32),
      tabHost: 'multi' as const, tabCount: 3 };
    expect(validForegroundWindow(binding)).toBe(true);
    expect(normalizeForegroundWindow(binding)?.tabId).toBe(binding.tabId);
    expect(normalizeForegroundWindow({ ...binding, tabId: 'msaa:' + 'a'.repeat(31) })?.tabId)
      .toBeUndefined();
    expect(normalizeForegroundWindow({ ...binding, tabId: 'msaa:terminal.example.org' })?.tabId)
      .toBeUndefined();
  });

  it('rejects persisted bindings from future, expired, or forged process identities', () => {
    const resolver = new AutoWindowResolver();
    const stored = { sessionKey: 'ssh:box:thread', inputToken: NOW - 100,
      savedAt: NOW - 100, window: { ...sample(NOW - 100, 'terminal'),
        inputAt: NOW - 100, tabHost: 'multi', tabId: 'msaa:' + 'b'.repeat(32) } };
    expect(resolver.restoreBindings([stored, { ...stored, sessionKey: 'invalid' }], NOW))
      .toEqual(['ssh:box:thread']);
    expect(resolver.get(stored.sessionKey)?.tabId).toBe(stored.window.tabId);
    expect(new AutoWindowResolver().restoreBindings(
      [{ ...stored, savedAt: NOW + 90_000 }], NOW)).toEqual([]);
    expect(new AutoWindowResolver().restoreBindings(
      [{ ...stored, savedAt: NOW - 31 * 24 * 60 * 60_000 }], NOW)).toEqual([]);
    expect(new AutoWindowResolver().restoreBindings(
      [{ ...stored, window: { ...stored.window, hwnd: 'attack' } }], NOW)).toEqual([]);
  });
});

describe('native HWND samples with delayed accessible-tab signals', () => {
  const event = (at: number, tabId?: string) => ({
    ...sample(at, 'terminal'), tabHost: 'multi' as const,
    tabCount: tabId ? 3 : 0, ...(tabId ? { tabId } : {}),
  });

  it('binds a unique MSAA tab despite interleaved window-only samples', () => {
    const resolver = new AutoWindowResolver();
    const id = 'msaa:' + 'e'.repeat(32);
    resolver.observeFocus(event(NOW - 2500));
    resolver.observeFocus(event(NOW - 2100, id));
    resolver.observeFocus(event(NOW - 300));
    resolver.observeFocus(event(NOW + 150));
    resolver.observeFocus(event(NOW + 450, id));
    const scan = makeScan(NOW + 900, 900);
    resolver.observeScan(scan, NOW + 1000);
    expect(resolver.get('ssh:server:thread')).toMatchObject({
      hwnd: '0x1234', tabId: id, tabCount: 3,
    });
  });

  it('does not bind a tab when the accessible selected tab changes', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(event(NOW - 2500, 'rid:1.10'));
    resolver.observeFocus(event(NOW - 200));
    resolver.observeFocus(event(NOW + 450, 'rid:1.11'));
    resolver.observeScan(makeScan(NOW + 900, 900), NOW + 1000);
    expect(resolver.get('ssh:server:thread')).toMatchObject({ tabId: null });
  });

  it('remains window-only if a late accessibility sample never arrived', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(event(NOW - 2500, 'rid:1.10'));
    resolver.observeFocus(event(NOW));
    resolver.observeScan(makeScan(NOW + 900, 900), NOW + 1000);
    expect(resolver.get('ssh:server:thread')).toMatchObject({ tabId: null });
  });

  it('does not confuse multiple known tab switches even when beginning and end match', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(event(NOW - 2500, 'rid:1.10'));
    resolver.observeFocus(event(NOW - 250, 'rid:1.11'));
    resolver.observeFocus(event(NOW + 120, 'rid:1.10'));
    resolver.observeScan(makeScan(NOW + 900, 900), NOW + 1000);
    expect(resolver.get('ssh:server:thread')).toMatchObject({ tabId: null });
  });
});

describe('asynchronous MobaXterm tab selection after the scan', () => {
  const idA = 'msaa:' + 'a'.repeat(32);
  const idB = 'msaa:' + 'b'.repeat(32);
  const tab = (at: number, id?: string) => ({
    ...sample(at, 'terminal'), tabHost: 'multi' as const,
    tabCount: id ? 3 : 0, ...(id ? { tabId: id } : {}),
  });
  it('upgrades a window-only binding when the same native tab is identified moments later', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(tab(NOW - 2500, idA));
    resolver.observeFocus(tab(NOW - 300));
    resolver.observeFocus(tab(NOW + 100));
    const scan = makeScan(NOW + 500, 500);
    resolver.observeScan(scan, NOW + 600);
    expect(resolver.get('ssh:server:thread')).toMatchObject({
      hwnd: '0x1234', tabId: null,
    });
    // The async UIA/MSAA worker reports after the scan and input deduplication.
    resolver.observeFocus(tab(NOW + 650, idA));
    expect(resolver.get('ssh:server:thread')?.tabId).toBe(idA);
    // Duplicate scan should not erase the upgraded tab.
    resolver.observeScan(scan, NOW + 700);
    expect(resolver.get('ssh:server:thread')?.tabId).toBe(idA);
  });
  it('never upgrades to a different selected tab or across another foreground app', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(tab(NOW - 2500, idA));
    resolver.observeFocus(tab(NOW - 300));
    resolver.observeFocus(tab(NOW + 100));
    resolver.observeScan(makeScan(NOW + 500, 500), NOW + 600);
    resolver.observeFocus(tab(NOW + 650, idB));
    expect(resolver.get('ssh:server:thread')?.tabId).toBeNull();
    const switched = new AutoWindowResolver();
    switched.observeFocus(tab(NOW - 2500, idA));
    switched.observeFocus(tab(NOW - 300));
    switched.observeFocus(tab(NOW + 100));
    switched.observeScan(makeScan(NOW + 500, 500), NOW + 600);
    switched.observeFocus(sample(NOW + 300, 'other', '0x555', 555));
    switched.observeFocus(tab(NOW + 650, idA));
    expect(switched.get('ssh:server:thread')?.tabId).toBeNull();
  });
  it('expires the pending upgrade after the short identification window', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(tab(NOW - 2500, idA));
    resolver.observeFocus(tab(NOW - 300));
    resolver.observeFocus(tab(NOW + 100));
    resolver.observeScan(makeScan(NOW + 500, 500), NOW + 600);
    resolver.observeFocus(tab(NOW + 4100, idA));
    expect(resolver.get('ssh:server:thread')?.tabId).toBeNull();
  });
});

describe('foreground session-specific notification suppression', () => {
  const key = 'local:active';
  const vscode = (at: number, hwnd = '0x1234', pid = 123) =>
    sample(at, 'vscode', hwnd, pid);

  it('suppresses only the bound active session, never unrelated windows or apps', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(vscode(NOW - 1000));
    resolver.observeScan(makeScan(NOW, 100, 'vscode', key), NOW);
    expect(resolver.isSessionForeground(key, NOW)).toBe(true);
    expect(resolver.isSessionForeground('local:another', NOW)).toBe(false);
    resolver.observeFocus(sample(NOW + 300, 'other', '0x9876', 987));
    expect(resolver.isSessionForeground(key, NOW + 400)).toBe(false);
    resolver.observeFocus(vscode(NOW + 1000));
    expect(resolver.isSessionForeground(key, NOW + 1300)).toBe(true);
    // The native hook must keep confirming this is still the foreground HWND.
    expect(resolver.isSessionForeground(key, NOW + 10_000)).toBe(false);
    resolver.observeFocus(vscode(NOW + 10_100));
    expect(resolver.isSessionForeground(key, NOW + 10_200)).toBe(true);
  });

  it('never guesses which of two VS Code conversations is visible in the same HWND', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(vscode(NOW - 3000));
    resolver.observeScan(makeScan(NOW, 100, 'vscode', 'local:thread-a'), NOW);
    resolver.observeScan(makeScan(NOW + 400, 100, 'vscode', 'local:thread-b'),
      NOW + 400);
    expect(resolver.get('local:thread-a')?.hwnd).toBe('0x1234');
    expect(resolver.get('local:thread-b')?.hwnd).toBe('0x1234');
    expect(resolver.isSessionForeground('local:thread-a', NOW + 500)).toBe(false);
    expect(resolver.isSessionForeground('local:thread-b', NOW + 500)).toBe(false);
    // Both sessions still have identities; activating one on a distinct HWND
    // makes the foreground match unambiguous again.
    resolver.observeFocus(vscode(NOW + 1000, '0xabcd', 321));
    resolver.observeScan(makeScan(NOW + 1100, 100, 'vscode', 'local:thread-b'),
      NOW + 1100);
    expect(resolver.isSessionForeground('local:thread-b', NOW + 1200)).toBe(true);
    expect(resolver.isSessionForeground('local:thread-a', NOW + 1200)).toBe(false);
  });

  it('requires the exact selected tab in multi-tab terminals, not just their window', () => {
    const resolver = new AutoWindowResolver();
    const tab = (at: number, tabId?: string) => ({
      ...sample(at, 'terminal'), tabHost: 'multi' as const, tabCount: 3,
      ...(tabId ? { tabId } : {}),
    });
    const key = 'ssh:server:thread';
    resolver.observeFocus(tab(NOW - 5000, 'rid:1.10'));
    resolver.observeFocus(tab(NOW - 1000, 'rid:1.10'));
    resolver.observeFocus(tab(NOW + 200, 'rid:1.10'));
    resolver.observeScan(makeScan(NOW + 100, 100), NOW + 300);
    expect(resolver.get(key)?.tabId).toBe('rid:1.10');
    expect(resolver.isSessionForeground(key, NOW + 300)).toBe(true);
    resolver.observeFocus(tab(NOW + 500, 'rid:1.11'));
    expect(resolver.isSessionForeground(key, NOW + 600)).toBe(false);
    resolver.observeFocus(tab(NOW + 1000)); // Current raw HWND without selected UIA tab.
    expect(resolver.isSessionForeground(key, NOW + 1200)).toBe(false);
    resolver.observeFocus(tab(NOW + 1300, 'rid:1.10'));
    expect(resolver.isSessionForeground(key, NOW + 1500)).toBe(true);
    expect(resolver.isSessionForeground(key, NOW + 6_000)).toBe(false);
  });

  it('refuses multi-tab suppression when selected tab identity is unknown', () => {
    const resolver = new AutoWindowResolver();
    const multi = (at: number) => ({
      ...sample(at, 'terminal'), tabHost: 'multi' as const, tabCount: 3,
    });
    resolver.observeFocus(multi(NOW - 1000));
    resolver.observeScan(makeScan(NOW, 100), NOW);
    expect(resolver.get('ssh:server:thread')?.tabId).toBeNull();
    expect(resolver.isSessionForeground('ssh:server:thread', NOW)).toBe(false);
  });

  it('never accepts a future foreground sample or a switched process behind reused HWND', () => {
    const resolver = new AutoWindowResolver();
    resolver.observeFocus(vscode(NOW - 1000));
    resolver.observeScan(makeScan(NOW, 100, 'vscode', key), NOW);
    resolver.observeFocus(vscode(NOW + 1000, '0x1234', 999));
    expect(resolver.isSessionForeground(key, NOW + 1100)).toBe(false);
    expect(resolver.isSessionForeground(key, NOW - 5000)).toBe(false);
  });
});
