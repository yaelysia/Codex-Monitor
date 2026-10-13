import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));

import { openDesktopUrlKeepingGeometry } from '../electron/desktop-window-guard';

class GuardChild extends EventEmitter {
  stdout = new EventEmitter();
  stdin = { end: vi.fn() };
  kills = 0;
  kill() { this.kills++; this.emit('exit', 0); return true; }
  ready(observed = 1) {
    this.stdout.emit('data', Buffer.from(JSON.stringify({
      type: 'desktop-window-guard', ready: true, observed,
    }) + '\n'));
  }
}

const URL = 'codex://threads/019a1020-0000-7000-8000-111122223333';
const GUARD = 'C:\\collector\\desktop-window-guard.ps1';
let child: GuardChild;
beforeEach(() => {
  vi.useFakeTimers();
  child = new GuardChild();
  fake.spawn.mockReset();
  fake.spawn.mockReturnValue(child);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('geometry-safe Codex Desktop protocol handoff', () => {
  it('captures first, invokes the existing deep link, then triggers conditional repair', async () => {
    const steps: string[] = [];
    const open = vi.fn(async (url: string) => { steps.push(url); });
    const promise = openDesktopUrlKeepingGeometry(URL, GUARD, open);
    expect(open).not.toHaveBeenCalled();
    child.ready();
    await promise;
    expect(open).toHaveBeenCalledExactlyOnceWith(URL);
    expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith('activated\n');
    expect(fake.spawn.mock.calls[0]?.[1]).toContain(GUARD);
    expect(steps).toEqual([URL]);
  });

  it('preserves deep-link failures and never repairs on failed protocol handoff', async () => {
    const failure = new Error('no protocol');
    const open = vi.fn(async () => { throw failure; });
    const pending = openDesktopUrlKeepingGeometry(URL, GUARD, open);
    child.ready();
    await expect(pending).rejects.toBe(failure);
    expect(child.stdin.end).toHaveBeenCalledWith('cancel\n');
  });

  it('does not block deep links when no Codex window is visible', async () => {
    const open = vi.fn(async () => {});
    const promise = openDesktopUrlKeepingGeometry(URL, GUARD, open);
    child.ready(0);
    await promise;
    expect(open).toHaveBeenCalledExactlyOnceWith(URL);
    expect(child.kills).toBe(1);
    expect(child.stdin.end).not.toHaveBeenCalled();
  });

  it('degrades safely when a window probe crashes or is silent', async () => {
    const open = vi.fn(async () => {});
    const crash = openDesktopUrlKeepingGeometry(URL, GUARD, open);
    child.emit('error', new Error('probe failed'));
    await crash;
    expect(open).toHaveBeenCalledTimes(1);
    child = new GuardChild();
    fake.spawn.mockReturnValueOnce(child);
    const silent = openDesktopUrlKeepingGeometry(URL, GUARD, open);
    await vi.advanceTimersByTimeAsync(2500);
    await silent;
    expect(open).toHaveBeenCalledTimes(2);
    expect(child.kills).toBe(1);
  });
});
