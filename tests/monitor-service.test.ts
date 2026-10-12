import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorAlert, MonitorState, ScanResponse, SessionRecord, Settings, SourceResult } from '../src/shared/types';

const fake = vi.hoisted(() => ({
  wake: null as null | ((sourceId: string) => void),
  reconciled: [] as string[][],
  started: 0,
  stopped: 0,
  health: {} as Record<string, 'active' | 'connecting' | 'fallback'>,
}));

vi.mock('../electron/config', () => ({
  readSettings: vi.fn(async () => ({ localRoot: '', wslRoots: {}, remotes: [] })),
}));
vi.mock('../electron/collector', () => ({
  refresh: vi.fn(),
  projectDesktopRuntime: vi.fn(async (snapshot: ScanResponse) => snapshot),
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

import { refresh as collect, projectDesktopRuntime } from '../electron/collector';
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
  fake.wake = null;
  fake.reconciled = [];
  fake.started = 0;
  fake.stopped = 0;
  fake.health = {};
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
