import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ScanResponse } from '../src/shared/types';

const fake = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\Codex-Monitor' },
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
      expect(tracker.status(sessionKey).message).toContain('重新发送一次消息');
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
