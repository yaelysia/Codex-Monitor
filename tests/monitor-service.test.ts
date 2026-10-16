import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MonitorAlert, MonitorState, ScanResponse, SessionRecord, Settings, SourceResult } from '../src/shared/types';

const fake = vi.hoisted(() => ({
  wake: null as null | ((sourceId: string) => void),
  reconciled: [] as string[][],
  started: 0,
  stopped: 0,
  health: {} as Record<string, 'active' | 'connecting' | 'fallback'>,
  desktopWake: null as null | (() => void),
  desktopWatcherHealthy: false,
}));

vi.mock('../electron/config', () => ({
  readSettings: vi.fn(async () => ({ localRoot: '', wslRoots: {}, remotes: [] })),
}));
vi.mock('../electron/collector', () => ({
  refresh: vi.fn(),
  projectDesktopRuntime: vi.fn(async (snapshot: ScanResponse) => snapshot),
  recentDesktopCompletions: vi.fn(() => []),
}));
vi.mock('../electron/desktop-log-watch', () => ({
  DesktopLogFolderWatcher: class {
    constructor(wake: () => void) { fake.desktopWake = wake; }
    get healthy() { return fake.desktopWatcherHealthy; }
    reconcile() {}
    close() { fake.desktopWake = null; }
  },
}));
vi.mock('../electron/watchers', () => ({
  WatchCoordinator: class {
    constructor(listener: (sourceId: string) => void) { fake.wake = listener; }
    start() { fake.started++; }
    stop() { fake.stopped++; }
    reconcile(_settings: Settings, sources: SourceResult[]) {
      fake.reconciled.push(sources.map(src => src.id));
    }
    status() { return fake.health; }
  },
}));

import { refresh as collect, projectDesktopRuntime, recentDesktopCompletions } from '../electron/collector';
import { MonitorService } from '../electron/monitor-service';

const NOW = 1_800_000_000_000;
const settings: Settings = { localRoot: '', wslRoots: {}, remotes: [] };
function session(id: string, status: SessionRecord['status'], at: number, child = false): SessionRecord {
  return {
    key: 'ssh:one:' + id, id, sourceId: 'ssh:one', sourceLabel: 'Server',
    status, statusReason: status, title: id, workspace: '/project',
    updatedAt: at, ageAtSourceMs: 1000, byteSize: status === 'finished' ? 250 : 150,
    finishedToken: status === 'finished' ? 'turn|'+id : null, startedAt: null, isSubagent: child,
  };
}
function source(id: string, sessions: SessionRecord[]): SourceResult {
  return { id, label: id, kind: id === 'local' ? 'local' : 'ssh', sessions, error: null };
}
function snapshot(scannedAt: number, sources: SourceResult[]): ScanResponse {
  return { scannedAt, sources };
}

let service: MonitorService | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(collect).mockReset();
  vi.mocked(projectDesktopRuntime).mockReset();
  vi.mocked(projectDesktopRuntime).mockImplementation(async snapshot => snapshot);
  vi.mocked(recentDesktopCompletions).mockReset();
  vi.mocked(recentDesktopCompletions).mockReturnValue([]);
  fake.wake = null;
  fake.reconciled = [];
  fake.started = 0;
  fake.stopped = 0;
  fake.health = {};
  fake.desktopWatcherHealthy = false;
  fake.desktopWake = null;
});
afterEach(() => {
  service?.stop();
  service = null;
  vi.useRealTimers();
});

describe('event-driven scan orchestration', () => {
  it('scans only the changed SSH host, merges local state, and emits one real parent completion', async () => {
    const delivered: MonitorAlert[] = [];
    const baseline = snapshot(NOW, [
      source('local', []), source('ssh:one', [session('parent', 'working', NOW)]),
    ]);
    const completed = snapshot(NOW + 500, [
      source('ssh:one', [
        session('parent', 'finished', NOW + 450),
        session('child', 'finished', NOW + 450, true),
      ]),
    ]);
    vi.mocked(collect).mockImplementation(async (_settings, selected) =>
      selected ? completed : baseline);

    service = new MonitorService(() => undefined, alert => delivered.push(alert));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(fake.started).toBe(1);
    expect(fake.reconciled).toEqual([['local', 'ssh:one']]);

    fake.wake?.('ssh:one');
    await vi.advanceTimersByTimeAsync(450);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(vi.mocked(collect).mock.calls[1]?.[1]).toEqual(new Set(['ssh:one']));
    // Targeted event scans can use a healthy local watcher-backed index;
    // manual/full scans always rediscover the directory tree.
    expect(vi.mocked(collect).mock.calls[1]?.[4]).toBe(false);
    expect(service.state().scan?.sources.map(x => x.id)).toEqual(['local', 'ssh:one']);
    expect(delivered.map(e => e.sessionId)).toEqual(['parent']);

    fake.wake?.('ssh:one');
    await vi.advanceTimersByTimeAsync(3500);
    expect(delivered).toHaveLength(1);
  });

  it('does not lose wake signals arriving while a targeted scan is in progress', async () => {
    const baseline = snapshot(NOW, [source('ssh:one', [session('p', 'working', NOW)])]);
    let resolvePending: ((value: ScanResponse) => void) | undefined;
    vi.mocked(collect).mockImplementation(async () => baseline);
    service = new MonitorService(() => undefined, () => undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    let rescans = 0;
    vi.mocked(collect).mockImplementation((_settings, selected) => {
      if (!selected) return Promise.resolve(baseline);
      rescans++;
      if (rescans === 1) {
        return new Promise<ScanResponse>(resolve => { resolvePending = resolve; });
      }
      return Promise.resolve(snapshot(Date.now(), [source('ssh:one', [session('p', 'finished', Date.now())])]));
    });

    fake.wake?.('ssh:one');
    await vi.advanceTimersByTimeAsync(500);
    expect(rescans).toBe(1);
    fake.wake?.('ssh:one');
    await vi.advanceTimersByTimeAsync(700);
    expect(rescans).toBe(1);
    resolvePending?.(baseline);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3500);
    expect(rescans).toBe(2);
  });

  it('keeps a 12-second targeted fallback for hosts with no active event stream', async () => {
    vi.mocked(collect).mockImplementation(async (_settings, selected) => snapshot(Date.now(),
      selected ? [source('ssh:one', [session('p', 'finished', Date.now())])] :
        [source('local', []), source('ssh:one', [session('p', 'working', Date.now())])]));
    service = new MonitorService(() => undefined, () => undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    fake.wake?.('ssh:one');
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.mocked(collect).mock.calls[1]?.[1]).toEqual(new Set(['ssh:one']));
    await vi.advanceTimersByTimeAsync(11_500);
    expect(vi.mocked(collect).mock.calls.length).toBeGreaterThanOrEqual(3);
    // SSH was refreshed by its filesystem event 11.5 seconds ago, so only
    // the local fallback source is due at this 12-second tick.
    expect(vi.mocked(collect).mock.calls.at(-1)?.[1])
      .toEqual(new Set(['local']));
  });

  it('limits healthy watch-connected hosts to a 60-second safety audit', async () => {
    fake.health = { local: 'active', 'ssh:one': 'active' };
    vi.mocked(collect).mockImplementation(async (_settings, target) => snapshot(Date.now(),
      target ? [source('ssh:one', [session('p', 'finished', Date.now())])] :
        [source('local', []), source('ssh:one', [session('p', 'working', Date.now())])]));
    service = new MonitorService(() => undefined, () => undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(48_000);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(vi.mocked(collect).mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it('falls back immediately when a formerly healthy SSH event stream goes down', async () => {
    fake.health = { local: 'active', 'ssh:one': 'active' };
    vi.mocked(collect).mockImplementation(async (_settings, target) => snapshot(Date.now(),
      target ? [source('ssh:one', [session('p', 'working', Date.now())])] :
        [source('local', []), source('ssh:one', [session('p', 'working', Date.now())])]));
    service = new MonitorService(() => undefined, () => undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    fake.health['ssh:one'] = 'fallback';
    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.mocked(collect).mock.calls.at(-1)?.[1]).toEqual(new Set(['ssh:one']));
  });

  it('never schedules a watcher-triggered scan after monitoring stops', async () => {
    vi.mocked(collect).mockImplementation(async () => snapshot(Date.now(), [source('local', [])]));
    service = new MonitorService(() => undefined, () => undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.stop();
    fake.wake?.('local');
    await vi.advanceTimersByTimeAsync(4000);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(fake.stopped).toBeGreaterThan(0);
  });
});


describe('Windows Desktop native lifecycle evidence without rescanning remote sources', () => {
  const desktopThread: SessionRecord = {
    key: 'ssh:one:019a21b0-aaaa-7ccc-8ddd-111122223333',
    id: '019a21b0-aaaa-7ccc-8ddd-111122223333',
    sourceId: 'ssh:one', sourceLabel: 'Server', workspace: null,
    title: 'Original CLI session reopened in Desktop',
    clientKind: 'terminal', status: 'unknown',
    statusReason: 'rollout not updated',
    updatedAt: NOW, startedAt: null, isSubagent: false,
  };

  it('updates a CLI-originated remote session on GUI log-only audit, then retracts after completion', async () => {
    fake.health = { local: 'active', 'ssh:one': 'active' };
    const pushed: MonitorState[] = [];
    vi.mocked(collect).mockImplementation(async () =>
      snapshot(Date.now(), [source('local', []), source('ssh:one', [desktopThread])]));
    let nativeReads = 0;
    vi.mocked(projectDesktopRuntime).mockImplementation(async baseline => {
      const result: ScanResponse = {
        ...baseline, sources: baseline.sources.map(src => ({
          ...src, sessions: src.sessions.map(record => ({ ...record })),
        })),
      };
      nativeReads++;
      const target = result.sources[1]!.sessions[0]!;
      if (nativeReads === 2) {
        target.status = 'working';
        target.statusReason = 'Desktop exact UUID turn/start accepted';
      }
      if (nativeReads >= 3) {
        target.status = 'unknown';
        target.statusReason = 'GUI native turn completed';
      }
      return result;
    });
    service = new MonitorService(state => pushed.push(state), () => undefined,
      () => undefined, 'win32');
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state().scan?.sources[1]?.sessions[0]?.status).toBe('unknown');
    await vi.advanceTimersByTimeAsync(4000);
    expect(service.state().scan?.sources[1]?.sessions[0]?.status).toBe('working');
    expect(collect).toHaveBeenCalledTimes(1); // No SSH/WSL rescan.
    await vi.advanceTimersByTimeAsync(4000);
    expect(service.state().scan?.sources[1]?.sessions[0]?.status).toBe('unknown');
    expect(collect).toHaveBeenCalledTimes(1);
    expect(pushed.length).toBeGreaterThanOrEqual(3);
  });

  it('skips native-only log audits after Monitor stops', async () => {
    vi.mocked(collect).mockImplementation(async () =>
      snapshot(Date.now(), [source('ssh:one', [desktopThread])]));
    service = new MonitorService(() => undefined, () => undefined, () => undefined, 'win32');
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = vi.mocked(projectDesktopRuntime).mock.calls.length;
    service.stop();
    await vi.advanceTimersByTimeAsync(12000);
    expect(vi.mocked(projectDesktopRuntime).mock.calls).toHaveLength(before);
  });
});

describe('Desktop ownership metadata is broadcast even if status is unchanged', () => {
  it('updates open-in-Desktop capability without waiting for an unrelated filesystem rescan', async () => {
    fake.health = { local: 'active', 'ssh:one': 'active' };
    const guiThread = session('019a21b0-aaaa-7ccc-8ddd-111122223333', 'working', NOW);
    guiThread.clientKind = 'terminal'; // Started in CLI, resumed in Codex Desktop.
    vi.mocked(collect).mockImplementation(async () =>
      snapshot(Date.now(), [source('ssh:one', [guiThread])]));
    let ticks = 0;
    vi.mocked(projectDesktopRuntime).mockImplementation(async baseline => {
      ticks++;
      const sources = baseline.sources.map(src => ({
        ...src, sessions: src.sessions.map(value => ({ ...value })),
      }));
      const row = sources[0]!.sessions[0]!;
      if (ticks === 2) row.desktopRuntimeObserved = true;
      if (ticks > 2) delete row.desktopRuntimeObserved;
      return { ...baseline, sources };
    });
    const emitted: MonitorState[] = [];
    service = new MonitorService(s => emitted.push(s), () => undefined,
      () => undefined, 'win32');
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.state().scan?.sources[0]?.sessions[0]?.desktopRuntimeObserved).toBeUndefined();
    await vi.advanceTimersByTimeAsync(4000);
    expect(service.state().scan?.sources[0]?.sessions[0]).toMatchObject({
      status: 'working', desktopRuntimeObserved: true,
    });
    expect(emitted.at(-1)?.scan?.sources[0]?.sessions[0]?.desktopRuntimeObserved).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(service.state().scan?.sources[0]?.sessions[0]?.desktopRuntimeObserved).toBeUndefined();
    expect(emitted.at(-1)?.scan?.sources[0]?.sessions[0]?.desktopRuntimeObserved).toBeUndefined();
    expect(collect).toHaveBeenCalledTimes(1);
  });
});

describe('notification state across Monitor process restarts', () => {
  it('restores read flags and muted setting without replaying OS notifications', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-service-inbox-'));
    try {
      const running = snapshot(NOW, [source('ssh:one', [session('p', 'working', NOW)])]);
      const done = snapshot(NOW + 12_000, [source('ssh:one', [
        session('p', 'finished', NOW + 10_000),
      ])]);
      vi.mocked(collect).mockResolvedValueOnce(running).mockResolvedValueOnce(done);
      const sent: MonitorAlert[] = [];
      service = new MonitorService(() => undefined, alert => sent.push(alert),
        () => {}, 'linux', dir);
      await service.refresh(true);
      vi.setSystemTime(NOW + 12_000);
      await service.refresh(true);
      expect(sent).toHaveLength(1);
      expect(service.state().alerts).toHaveLength(1);
      service.acknowledge(sent[0]!.id);
      service.setMuted(true);
      service.stop();
      service = null;
      const second = new MonitorService(() => undefined, alert => sent.push(alert),
        () => {}, 'linux', dir);
      try {
        expect(second.state().muted).toBe(true);
        expect(second.state().alerts).toMatchObject([{ read: true, kind: 'finished' }]);
        expect(second.state().alerts[0]?.title).toBe('已保存的任务提醒');
        expect(sent).toHaveLength(1);
      } finally { second.stop(); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// Desktop native completion is a notification source even if the read-only
// filesystem snapshot and GUI-projected task status are unchanged.
describe('native GUI completion notification orchestration', () => {
  it('delivers one real parent completion without remote or local rescan', async () => {
    const ID = '019a21b0-aaaa-7ccc-8ddd-111122223333';
    const TURN = '019a21b0-aaaa-7ccc-8ddd-777788889999';
    fake.health = {local:'active'};
    const raw = snapshot(NOW, [source('local', [{
      ...session(ID,'working',NOW), key:'local:'+ID, sourceId:'local',
      sourceLabel:'Windows', clientKind:'desktop', isSubagent:false,
    }])]);
    vi.mocked(collect).mockResolvedValue(raw);
    const delivered: MonitorAlert[] = [];
    service = new MonitorService(() => undefined, a => delivered.push(a),
      () => undefined, 'win32');
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(recentDesktopCompletions).mockReturnValue([{
      threadId:ID,type:'turn-displayed-complete',turnId:TURN,at:NOW+3000,
    }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(delivered).toMatchObject([{kind:'finished',sessionId:ID}]);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(delivered).toHaveLength(1);
    expect(service.state().alerts).toHaveLength(1);
  });
});

describe('Desktop event-driven wakeups with bounded safety scans', () => {
  it('coalesces native file events and uses 12s audits when covered, 4s if not', async () => {
    // Normal source watchers remain healthy; otherwise their own 12s
    // filesystem fallback would correctly trigger a separate collection.
    fake.health = { local: 'active' };
    const baseline = snapshot(NOW, [source('local', [session('p', 'unknown', NOW)])]);
    vi.mocked(collect).mockResolvedValue(baseline);
    service = new MonitorService(() => undefined, () => undefined,
      () => undefined, 'win32');
    // Healthy directory coverage is used only after log inspection succeeds.
    fake.desktopWatcherHealthy = true;
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(projectDesktopRuntime).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(projectDesktopRuntime).toHaveBeenCalledTimes(1);
    fake.desktopWake?.();
    fake.desktopWake?.();
    await vi.advanceTimersByTimeAsync(250);
    expect(projectDesktopRuntime).toHaveBeenCalledTimes(2);
    // File wakeups never force a remote or filesystem rescan.
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(projectDesktopRuntime).toHaveBeenCalledTimes(2);
    fake.desktopWatcherHealthy = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(vi.mocked(projectDesktopRuntime).mock.calls.length).toBeGreaterThan(2);
    expect(collect).toHaveBeenCalledTimes(1);
  });
});

describe('native completion captured during filesystem refresh', () => {
  it('notifies on the same full scan and does not repeat on next Desktop audit', async () => {
    const ID = '019a21b0-aaaa-7ccc-8ddd-111122223333';
    const TURN = '019a21b0-aaaa-7ccc-8ddd-777788889999';
    fake.health = { local: 'active' };
    const sourceRow = { ...session(ID,'working',NOW), key:'local:'+ID,
      sourceId:'local', sourceLabel:'Windows', clientKind:'desktop' as const };
    vi.mocked(collect).mockResolvedValue(snapshot(NOW,[source('local',[sourceRow])]));
    const sent: MonitorAlert[] = [];
    service = new MonitorService(() => undefined, a => sent.push(a),
      () => undefined, 'win32');
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(recentDesktopCompletions).mockReturnValue([{
      threadId:ID,type:'turn-displayed-complete',turnId:TURN,at:NOW+1000,
    }]);
    await vi.advanceTimersByTimeAsync(1100);
    await service.refresh(true);
    expect(sent).toMatchObject([{kind:'finished',sessionId:ID}]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toHaveLength(1);
  });
});

describe('independent source delivery and disconnection history', () => {
  it('publishes a completed local turn before a slow remote host settles', async () => {
    const baseline = snapshot(NOW, [
      source('local', [{...session('fast','working',NOW),
        sourceId:'local', key:'local:fast', sourceLabel:'Windows'}]),
      source('ssh:one',[session('remote','working',NOW)]),
    ]);
    const delivered: MonitorAlert[] = [];
    const states: MonitorState[] = [];
    vi.mocked(collect).mockResolvedValueOnce(baseline);
    service = new MonitorService(state => states.push(state), alert => delivered.push(alert));
    service.start();
    await vi.advanceTimersByTimeAsync(0);

    const fast = source('local',[{...session('fast','finished',NOW+1000),
      sourceId:'local',key:'local:fast',sourceLabel:'Windows',byteSize:250}]);
    const slow = source('ssh:one',[session('remote','working',NOW)]);
    let release: (() => void) | undefined;
    vi.mocked(collect).mockImplementationOnce(async (_settings, _ids, _pins, onSource) => {
      await onSource?.(fast);
      await new Promise<void>(resolve => { release = resolve; });
      await onSource?.(slow);
      return snapshot(Date.now(), [fast, slow]);
    });

    const pending = service.refresh(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeTypeOf('function');
    expect(delivered.map(alert => alert.sessionId)).toEqual(['fast']);
    expect(states.at(-1)?.scan?.sources.find(s => s.id === 'local')
      ?.sessions[0]?.status).toBe('finished');
    // The remote host is still pending and is not allowed to block the alert.
    release?.();
    await pending;
    expect(delivered).toHaveLength(1);
    expect(service.state().scan?.sources.map(s=>s.id)).toEqual(['local','ssh:one']);
  });

  it('keeps recent healthy sessions and rollout pins across a temporary SSH failure', async () => {
    const running = {...session('p','working',NOW),
      rolloutPath:'2026/10/12/rollout-active.jsonl'};
    const healthy = snapshot(NOW,[source('ssh:one',[running])]);
    const offline = source('ssh:one',[]);
    offline.error = 'SSH connection reset';
    vi.mocked(collect).mockResolvedValueOnce(healthy)
      .mockResolvedValueOnce(snapshot(NOW + 1000,[offline]))
      .mockResolvedValueOnce(snapshot(NOW + 2000,[source('ssh:one',[
        {...running,status:'finished',finishedToken:'done|p',
          updatedAt:NOW + 1800,byteSize:200},
      ])]));
    const delivered: MonitorAlert[] = [];
    service = new MonitorService(()=>undefined, alert=>delivered.push(alert));
    await service.refresh(true);
    await service.refresh(true);
    const retained = service.state().scan?.sources[0];
    expect(retained).toMatchObject({error:'SSH connection reset',stale:true});
    expect(retained?.sessions).toHaveLength(1);
    expect(retained?.sessions[0]).toMatchObject({status:'unknown',id:'p'});
    expect(retained?.sessions[0]?.statusReason).toContain('上次成功');
    expect(delivered).toEqual([]);
    await service.refresh(true);
    expect(vi.mocked(collect).mock.calls[2]?.[2]?.get('ssh:one'))
      .toEqual(['2026/10/12/rollout-active.jsonl']);
    expect(service.state().scan?.sources[0]?.error).toBeNull();
    expect(service.state().scan?.sources[0]?.sessions[0]?.status).toBe('finished');
    expect(service.state().scan?.sources[0]?.stale).toBeUndefined();
    expect(delivered.map(a=>a.kind)).toEqual(['finished']);
  });
});

describe('local watcher index enablement', () => {
  it('only uses incremental indexing for healthy local partial scans', async () => {
    const local = source('local', [{
      ...session('local-task','working',NOW), sourceId:'local',
      sourceLabel:'Windows', key:'local:local-task',
    }]);
    vi.mocked(collect).mockImplementation(async () => snapshot(Date.now(),[local]));
    service = new MonitorService(() => undefined, () => undefined);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(collect).mock.calls[0]?.[4]).toBe(false);

    fake.health = {local:'active'};
    fake.wake?.('local');
    await vi.advanceTimersByTimeAsync(450);
    expect(vi.mocked(collect).mock.calls.at(-1)?.[1]).toEqual(new Set(['local']));
    expect(vi.mocked(collect).mock.calls.at(-1)?.[4]).toBe(true);

    // A manual all-source refresh must bypass the index regardless of health.
    await service.refresh(true);
    expect(vi.mocked(collect).mock.calls.at(-1)?.[1]).toBeUndefined();
    expect(vi.mocked(collect).mock.calls.at(-1)?.[4]).toBe(false);
  });
});

describe('monitor service source alert integration', () => {
  it('keeps brief SSH failures silent and alerts sustained failure + later recovery exactly once', async () => {
    const initial = source('ssh:one',[session('work','working',NOW)]);
    const failed = source('ssh:one',[]);
    failed.error = 'PRIVATE_SSH_CONNECTION_FAILURE';
    const recovered = source('ssh:one',[session('work','working',NOW+40_000)]);
    vi.mocked(collect).mockResolvedValueOnce(snapshot(NOW,[initial]))
      .mockResolvedValueOnce(snapshot(NOW+1000,[failed]))
      .mockResolvedValueOnce(snapshot(NOW+12_000,[failed]))
      .mockResolvedValueOnce(snapshot(NOW+32_000,[failed]))
      .mockResolvedValueOnce(snapshot(NOW+48_000,[failed]))
      .mockResolvedValueOnce(snapshot(NOW+49_000,[recovered]));
    const sent: MonitorAlert[] = [];
    service = new MonitorService(() => undefined, alert => sent.push(alert));
    await service.refresh(true);
    vi.setSystemTime(NOW+1000);
    await service.refresh(true);
    expect(service.state().scan?.sources[0]?.stale).toBe(true);
    vi.setSystemTime(NOW+12_000);
    await service.refresh(true);
    expect(sent).toEqual([]);
    vi.setSystemTime(NOW+32_000);
    await service.refresh(true);
    expect(sent.map(a=>a.kind)).toEqual(['source-offline']);
    expect(sent[0]?.sessionKey).toBe('@source:ssh:one');
    vi.setSystemTime(NOW+48_000);
    await service.refresh(true);
    expect(sent).toHaveLength(1);
    vi.setSystemTime(NOW+49_000);
    await service.refresh(true);
    expect(sent.map(a=>a.kind)).toEqual(['source-offline','source-recovered']);
    expect(service.state().scan?.sources[0]?.error).toBeNull();
  });

  it('forgets removed source health on a full scan without fabricating a recovery', async () => {
    const failed = source('ssh:one',[]);
    failed.error = 'offline';
    vi.mocked(collect).mockResolvedValueOnce(snapshot(NOW,[failed]))
      .mockResolvedValueOnce(snapshot(NOW+31_000,[failed]))
      .mockResolvedValueOnce(snapshot(NOW+32_000,[source('local',[])]));
    const events: MonitorAlert[] = [];
    service = new MonitorService(() => undefined, a => events.push(a));
    await service.refresh(true);
    vi.setSystemTime(NOW+31_000);
    await service.refresh(true);
    expect(events.map(a=>a.kind)).toEqual(['source-offline']);
    vi.setSystemTime(NOW+32_000);
    await service.refresh(true);
    expect(events).toHaveLength(1);
    expect(service.state().scan?.sources.map(s=>s.id)).toEqual(['local']);
  });
});

describe('selective notification delivery across both scan and native pathways', () => {
  it('suppresses disabled scan-toasts and unread counts but preserves future enabled turns', async () => {
    const base=snapshot(NOW,[source('ssh:one',[session('p','working',NOW)])]);
    const ended=snapshot(NOW+1000,[source('ssh:one',[{
      ...session('p','finished',NOW+1000),finishedToken:'end|first',
    }])]);
    const next=snapshot(NOW+3000,[source('ssh:one',[{
      ...session('p','finished',NOW+3000),finishedToken:'end|second',byteSize:300,
    }])]);
    vi.mocked(collect).mockResolvedValueOnce(base).mockResolvedValueOnce(ended)
      .mockResolvedValueOnce(next);
    const toasts: MonitorAlert[] = [];
    const states: MonitorState[] = [];
    service=new MonitorService(state=>states.push(state),alert=>toasts.push(alert));
    await service.refresh(true);
    expect(service.state().notificationKinds?.finished).toBe(true);
    service.setNotificationKindEnabled('finished',false);
    vi.setSystemTime(NOW+1500);
    await service.refresh(true);
    expect(toasts).toHaveLength(0);
    expect(service.state().alerts).toMatchObject([{kind:'finished',read:true}]);
    expect(states.at(-1)?.notificationKinds?.finished).toBe(false);
    service.setNotificationKindEnabled('finished',true);
    vi.setSystemTime(NOW+3500);
    await service.refresh(true);
    expect(toasts).toMatchObject([{kind:'finished',read:false}]);
    expect(service.state().alerts.filter(a=>!a.read)).toHaveLength(1);
  });

  it('suppresses native Desktop OS delivery using the same persisted kind rule', async () => {
    const thread='019a21b0-aaaa-7ccc-8ddd-111122223333';
    const turn='019a21b0-aaaa-7ccc-8ddd-777788889999';
    fake.health={local:'active'};
    const sessionRow={...session(thread,'working',NOW),key:'local:'+thread,
      sourceId:'local',sourceLabel:'Windows',clientKind:'desktop' as const};
    vi.mocked(collect).mockResolvedValue(snapshot(NOW,[source('local',[sessionRow])]));
    const sent: MonitorAlert[]=[];
    service=new MonitorService(()=>undefined, alert=>sent.push(alert),()=>undefined,'win32');
    service.setNotificationKindEnabled('finished',false);
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(recentDesktopCompletions).mockReturnValue([{
      threadId:thread,type:'turn-displayed-complete',turnId:turn,at:NOW+3000,
    }]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual([]);
    expect(service.state().alerts).toMatchObject([{kind:'finished',read:true}]);
    service.setNotificationKindEnabled('finished',true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toEqual([]);
    expect(service.state().alerts).toHaveLength(1);
  });
});

describe('scan revision avoids heavy UI regrouping on notification-only state updates',()=>{
  it('advances for new scans but not for mute, unread, or notification preference changes',async()=>{
    vi.mocked(collect).mockResolvedValue(snapshot(NOW,[
      source('local',[session('parent','working',NOW)]),
    ]));
    const emitted:MonitorState[]=[];
    service=new MonitorService(state=>emitted.push(state),()=>undefined);
    expect(service.state().scanRevision).toBe(0);
    await service.refresh(true);
    const first=service.state().scanRevision!;
    expect(first).toBeGreaterThan(0);
    service.setMuted(true);
    service.setNotificationKindEnabled('finished',false);
    service.acknowledge('unknown-id');
    expect(service.state().scanRevision).toBe(first);
    expect(emitted.at(-1)?.scanRevision).toBe(first);
    await service.refresh(true);
    expect(service.state().scanRevision).toBeGreaterThan(first);
  });
});
