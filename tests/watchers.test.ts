import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WatchCoordinator, parseWatcherSignal } from '../electron/watchers';
import type { Settings, SourceResult } from '../src/shared/types';

const folders: string[] = [];
const coordinators: WatchCoordinator[] = [];
afterEach(async () => {
  coordinators.splice(0).forEach(item => item.stop());
  await Promise.all(folders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })));
});

describe('event watcher protocol', () => {
  it('accepts only bounded, well formed event signals', () => {
    expect(parseWatcherSignal('{"kind":"ready"}')).toBe('ready');
    expect(parseWatcherSignal('{"kind":"change"}')).toBe('change');
    expect(parseWatcherSignal('{"kind":"heartbeat"}')).toBe('heartbeat');
    expect(parseWatcherSignal('{"kind":"change","session":"secret"}')).toBe('change');
    for (const value of ['', 'not json', '[]', '{}', '{"kind":"delete"}',
      '{"kind":17}', '{"kind":"change"}'.repeat(1000)]) {
      expect(parseWatcherSignal(value)).toBeNull();
    }
  });

  it('watches only Codex sessions, supports new files and stops cleanly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-watch-'));
    folders.push(root);
    const target = path.join(root, 'sessions', '2026', '10', '12');
    await fs.mkdir(target, { recursive: true });
    const changes: string[] = [];
    const monitor = new WatchCoordinator(id => changes.push(id));
    coordinators.push(monitor);
    monitor.start();
    const settings: Settings = { localRoot: root, wslRoots: {}, remotes: [] };
    const sources: SourceResult[] = [
      { id: 'local', label: 'Windows', kind: 'local', sessions: [], error: null },
    ];
    monitor.reconcile(settings, sources);
    const filename = path.join(target, 'rollout-local.jsonl');
    await fs.writeFile(filename, '{"type":"event_msg"}\n');
    const deadline = Date.now() + 3500;
    while (changes.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(changes).toContain('local');
    expect(monitor.status().local).toBe('active');
    monitor.stop();
    changes.length = 0;
    await fs.appendFile(filename, '{"type":"event_msg"}\n');
    await new Promise(resolve => setTimeout(resolve, 75));
    expect(changes).toEqual([]);
  }, 8000);

  it('reconcile is idempotent and removing a source closes its watcher', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-watch-reconcile-'));
    folders.push(root);
    await fs.mkdir(path.join(root, 'sessions'));
    const changes: string[] = [];
    const monitor = new WatchCoordinator(id => changes.push(id));
    coordinators.push(monitor);
    monitor.start();
    const settings: Settings = { localRoot: root, wslRoots: {}, remotes: [] };
    const source: SourceResult = {
      id: 'local', label: 'Windows', kind: 'local', sessions: [], error: null,
    };
    monitor.reconcile(settings, [source]);
    monitor.reconcile(settings, [source]);
    monitor.reconcile(settings, []);
    expect(monitor.status().local).toBeUndefined();
    await fs.writeFile(path.join(root, 'sessions', 'rollout-test.jsonl'), '{}');
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(changes).toEqual([]);
  });
});
