import { describe, expect, it } from 'vitest';
import { AutoWindowResolver, validForegroundWindow } from '../src/shared/auto-window-binding';
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
