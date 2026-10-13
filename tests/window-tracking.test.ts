import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ScanResponse, SessionRecord } from '../src/shared/types';

const fake = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(), openExternal: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\Codex-Monitor' },
  shell: { openExternal: fake.openExternal },
}));
vi.mock('node:child_process', () => ({
  spawn: fake.spawn,
  execFile: fake.execFile,
}));

import { AutoWindowTracker } from '../electron/window-tracking';

class NativeChild extends EventEmitter {
  stdout = new EventEmitter();
  kills = 0;
  kill(): boolean {
    this.kills++;
    this.emit('exit', 1);
    return true;
  }
}

const children: NativeChild[] = [];
const sample = (at: number) => JSON.stringify({
  type: 'foreground', at, hwnd: '0x1357', pid: 1357,
  startedAt: 1000, app: 'vscode',
}) + '\n';
const sessionKey = 'local:019a1020-0000-7000-8000-111122223333';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-12T08:00:00Z'));
  children.length = 0;
  fake.spawn.mockReset();
  fake.execFile.mockReset();
  fake.openExternal.mockReset();
  fake.openExternal.mockResolvedValue(undefined);
  fake.spawn.mockImplementation(() => {
    const child = new NativeChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Windows foreground watcher recovery', () => {
  it('starts listening only after a valid foreground sample is received', () => {
    const tracker = new AutoWindowTracker('win32');
    try {
      tracker.start();
      expect(children).toHaveLength(1);
      expect(tracker.status(sessionKey).ready).toBe(false);
      children[0]!.stdout.emit('data', Buffer.from(sample(Date.now() - 1000)));
      expect(tracker.status(sessionKey).message).toContain('再次发送消息');
    } finally { tracker.stop(); }
  });

  it('automatically retries after native watch exits and does not restart after stop', async () => {
    const tracker = new AutoWindowTracker('win32');
    tracker.start();
    expect(children).toHaveLength(1);
    children[0]!.emit('exit', 1);
    expect(tracker.status(sessionKey).message).toContain('恢复');
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(2);
    tracker.stop();
    children[1]!.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(2);
  });

  it('restarts a native observer that never publishes valid foreground evidence', async () => {
    const tracker = new AutoWindowTracker('win32');
    try {
      tracker.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(children[0]?.kills).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(children).toHaveLength(2);
      children[1]!.stdout.emit('data', Buffer.from(sample(Date.now() - 1000)));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(children).toHaveLength(2);
      expect(children[1]?.kills).toBe(0);
    } finally { tracker.stop(); }
  });

  it('keeps a safely revalidated HWND binding when only the watcher stops', () => {
    const tracker = new AutoWindowTracker('win32');
    try {
      const at = Date.now();
      tracker.start();
      children[0]!.stdout.emit('data', Buffer.from(sample(at - 1000)));
      const scan: ScanResponse = {
        scannedAt: at, sources: [{
          id: 'local', label: 'Windows', kind: 'local', error: null,
          sessions: [{
            key: sessionKey, id: sessionKey.slice(6), sourceId: 'local',
            sourceLabel: 'Windows', workspace: null,
            title: null, status: 'working', statusReason: 'test',
            updatedAt: at, startedAt: null, clientKind: 'vscode',
            lastUserInputAgeAtSourceMs: 100,
          }],
        }],
      };
      tracker.observeScan(scan);
      expect(tracker.status(sessionKey).ready).toBe(true);
      children[0]!.emit('exit', 1);
      expect(tracker.status(sessionKey).ready).toBe(true);
    } finally { tracker.stop(); }
  });
});

describe('original-window persistent bindings across Monitor restarts', () => {
  it('reloads the binding without another user prompt, then revalidates before focus', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-window-binding-'));
    const now = Date.now();
    try {
      const tracker = new AutoWindowTracker('win32', storage);
      tracker.start();
      children[0]!.stdout.emit('data', Buffer.from(sample(now - 1000)));
      const scan: ScanResponse = { scannedAt: now, sources: [{
        id: 'local', kind: 'local', label: 'Windows', error: null, sessions: [{
          key: sessionKey, id: sessionKey.slice(6), sourceId: 'local',
          sourceLabel: 'Windows', workspace: null, title: null,
          status: 'working', statusReason: 'test', updatedAt: now,
          startedAt: null, clientKind: 'vscode', lastUserInputAgeAtSourceMs: 100,
          lastUserInputAtSourceMs: now - 100,
        }],
      }] };
      tracker.observeScan(scan);
      expect(tracker.status(sessionKey).ready).toBe(true);
      tracker.stop();
      const file = path.join(storage, 'window-bindings.json');
      expect(fs.existsSync(file)).toBe(true);
      const persisted = fs.readFileSync(file, 'utf8');
      expect(persisted).toContain(sessionKey);
      expect(persisted).not.toContain('statusReason');

      const reopened = new AutoWindowTracker('win32', storage);
      try {
        reopened.start();
        expect(reopened.status(sessionKey).ready).toBe(true);
        expect(reopened.status(sessionKey).message).toContain('上次窗口绑定');
        fake.execFile.mockImplementationOnce((_cmd, _args, _options, cb) =>
          cb(null, '{"ok":true,"tabFocused":false}\n', ''));
        const result = await reopened.focusOriginalWindow(sessionKey);
        expect(result.state).toBe('focused');
        const nativeArguments = fake.execFile.mock.calls.at(-1)?.[1] as string[];
        expect(nativeArguments).toContain('0x1357');
        expect(nativeArguments).toContain('1357');
        expect(nativeArguments).toContain('1000');
      } finally { reopened.stop(); }
    } finally { fs.rmSync(storage, { recursive: true, force: true }); }
  });

  it('does not activate or retain an OS window when native verification finds it stale', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binding-stale-'));
    const now = Date.now();
    try {
      const persisted = { version: 1, bindings: [{
        sessionKey, savedAt: now - 10_000, inputToken: now - 10_000,
        window: { at: now - 10_000, inputAt: now - 10_000,
          hwnd: '0xbeef', pid: 777, startedAt: now - 90_000, app: 'vscode' },
      }] };
      fs.writeFileSync(path.join(storage, 'window-bindings.json'), JSON.stringify(persisted));
      const tracker = new AutoWindowTracker('win32', storage);
      try {
        tracker.start();
        expect(tracker.status(sessionKey).ready).toBe(true);
        fake.execFile.mockImplementationOnce((_cmd, _args, _options, cb) =>
          cb(null, '{"ok":false,"reason":"process_changed"}\n', ''));
        const result = await tracker.focusOriginalWindow(sessionKey);
        expect(result.state).toBe('stale');
        expect(tracker.status(sessionKey).ready).toBe(false);
      } finally { tracker.stop(); }
      const next = JSON.parse(fs.readFileSync(path.join(storage, 'window-bindings.json'), 'utf8'));
      expect(next.bindings).toHaveLength(0);
    } finally { fs.rmSync(storage, { recursive: true, force: true }); }
  });
});

describe('Desktop official deep-link navigation', () => {
  const desktop = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: sessionKey.slice('local:'.length), key: sessionKey,
    sourceId: 'local', sourceLabel: 'Windows', workspace: null,
    title: 'Desktop task', status: 'working', statusReason: 'native',
    clientKind: 'desktop', updatedAt: Date.now(), startedAt: null,
    ...overrides,
  });

  it('opens the exact Desktop thread without waiting for an HWND binding', async () => {
    const tracker = new AutoWindowTracker('win32');
    expect(tracker.status(sessionKey).ready).toBe(false);
    expect(tracker.status(sessionKey, desktop())).toMatchObject({
      ready: true, host: 'desktop',
    });
    const result = await tracker.focusOriginalWindow(sessionKey, desktop());
    expect(result.state).toBe('opened');
    expect(fake.openExternal).toHaveBeenCalledExactlyOnceWith(
      'codex://threads/019a1020-0000-7000-8000-111122223333');
    expect(fake.execFile).not.toHaveBeenCalled();
  });

  it('handles a CLI-originated thread resumed in Desktop without hijacking a normal CLI task', async () => {
    const tracker = new AutoWindowTracker('win32');
    const cli = desktop({ clientKind: 'terminal' });
    expect(tracker.status(sessionKey, cli).ready).toBe(false);
    await tracker.focusOriginalWindow(sessionKey, { ...cli, desktopRuntimeObserved: true });
    expect(fake.openExternal).toHaveBeenCalledTimes(1);
    expect(tracker.status(sessionKey, { ...cli, desktopRuntimeObserved: true })).toMatchObject({
      ready: true, host: 'desktop',
    });
  });

  it('reports an unregistered Desktop protocol instead of guessing a window', async () => {
    const tracker = new AutoWindowTracker('win32');
    fake.openExternal.mockRejectedValueOnce(new Error('protocol not registered'));
    const result = await tracker.focusOriginalWindow(sessionKey, desktop());
    expect(result.state).toBe('unavailable');
    expect(result.message).toContain('codex://');
    expect(fake.execFile).not.toHaveBeenCalled();
  });

  it('falls back to a previously verified HWND if protocol invocation fails', async () => {
    const tracker = new AutoWindowTracker('win32');
    const at = Date.now();
    tracker.start();
    try {
      children.at(-1)!.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'foreground', at: at - 1000, hwnd: '0x1357', pid: 1357,
        startedAt: 1000, app: 'desktop',
      }) + '\n'));
      const s: ScanResponse = { scannedAt: at, sources: [{
        id: 'local', kind: 'local', label: 'Windows', error: null,
        sessions: [{ ...desktop(), lastUserInputAgeAtSourceMs: 200 }],
      }] };
      tracker.observeScan(s);
      expect(tracker.status(sessionKey).ready).toBe(true);
      fake.openExternal.mockRejectedValueOnce(new Error('protocol missing'));
      fake.execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, '{"ok":true,"tabFocused":false}\n', '');
      });
      expect((await tracker.focusOriginalWindow(sessionKey, desktop())).state).toBe('focused');
      expect(fake.execFile).toHaveBeenCalledTimes(1);
    } finally { tracker.stop(); }
  });
});
