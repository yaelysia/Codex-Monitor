import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import type { FSWatcher } from 'node:fs';
import { DesktopLogFolderWatcher, MAX_DESKTOP_WATCH_DIRS } from
  '../electron/desktop-log-watch';

class FakeWatcher extends EventEmitter {
  closed = false;
  close() { this.closed = true; }
  changed() { this.emit('change'); }
}
const folder = (name: string) => path.resolve('logs', name);

describe('bounded Desktop event-watch coverage and fallback', () => {
  it('wakes on changes, deduplicates subscriptions and disposes safely', () => {
    const created: FakeWatcher[] = [];
    const wake = vi.fn();
    const observer = new DesktopLogFolderWatcher(wake, () => {
      const item = new FakeWatcher(); created.push(item);
      return item as unknown as FSWatcher;
    });
    observer.reconcile([folder('today'), folder('today'), folder('yesterday')]);
    expect(observer.healthy).toBe(true);
    expect(created).toHaveLength(2);
    created[0]!.changed();
    expect(wake).toHaveBeenCalledTimes(1);
    observer.reconcile([folder('today')]);
    expect(created[1]!.closed).toBe(true);
    observer.close();
    expect(created[0]!.closed).toBe(true);
    created[0]!.changed();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('reverts to polling if watch coverage is incomplete or handle fails', () => {
    const wake = vi.fn();
    const created: FakeWatcher[] = [];
    const subscribe = vi.fn((_name: string) => {
      const item = new FakeWatcher(); created.push(item);
      return item as unknown as FSWatcher;
    });
    const observer = new DesktopLogFolderWatcher(wake, subscribe);
    observer.reconcile(Array.from({length:MAX_DESKTOP_WATCH_DIRS+1},
      (_,i)=>folder('day-'+i)));
    expect(observer.healthy).toBe(false);
    expect(subscribe).not.toHaveBeenCalled();
    observer.reconcile([folder('today')], 1000);
    expect(observer.healthy).toBe(true);
    created[0]!.emit('error', new Error('watch failure'));
    expect(observer.healthy).toBe(false);
    expect(created[0]!.closed).toBe(true);
    observer.reconcile([folder('today')], Date.now() + 31_000);
    expect(observer.healthy).toBe(true);
    observer.close();
  });
});
