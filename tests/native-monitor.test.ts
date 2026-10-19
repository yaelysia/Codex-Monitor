import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeMonitor, type NativeClient } from '../electron/native-monitor';
import type { NativeConnection } from '../src/shared/native-state';
import type { ScanResponse, SessionRecord } from '../src/shared/types';
const NOW = 1_800_000_000_000;
const uuid = (n: number) => '019a1020-0000-7000-8000-' + String(n).padStart(12, '0');
function snapshot(count = 1, sourceId = 'local'): ScanResponse {
  return { scannedAt: NOW, sources: [{ id: sourceId, label: sourceId, kind: sourceId === 'local' ? 'local' : 'ssh',
    capturedAt: NOW, error: null, sessions: Array.from({ length: count }, (_, i): SessionRecord => ({
      id: uuid(i), key: sourceId + ':' + uuid(i), sourceId, sourceLabel: sourceId, title: 'test', workspace: null,
      status: 'unknown', statusReason: 'log', updatedAt: NOW - 1000, ageAtSourceMs: 1000, startedAt: null,
    })) }] };
}
const config: NativeConnection = { sourceId: 'local', enabled: true, transport: 'ws', endpoint: 'ws://127.0.0.1:9876/' };
class Client implements NativeClient {
  closed = false;
  stats = { serverRequests: 0 };
  ids = [uuid(0)];
  status: unknown = { type: 'active', activeFlags: [] };
  fail = false;
  start = vi.fn(async () => { this.closed = false; });
  close = vi.fn(async () => { this.closed = true; });
  request = vi.fn(async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (this.fail) throw new Error('SECRET_ERROR');
    if (method === 'thread/loaded/list') {
      const offset = params.cursor ? Number(params.cursor) : 0;
      return { data: this.ids.slice(offset, offset + 100), nextCursor: offset + 100 < this.ids.length ? String(offset + 100) : null };
    }
    if (method === 'thread/read') return { thread: { id: params.threadId, status: this.status, title: 'SECRET_TITLE', turns: ['SECRET_PAYLOAD'] } };
    throw new Error('Unexpected method');
  });
}
let native: NativeMonitor | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { native?.stop(); native = undefined; vi.useRealTimers(); });
function setup(client = new Client(), scan = snapshot()) {
  const changed = vi.fn(), factory = vi.fn(() => client);
  native = new NativeMonitor('/home/test/.codex', changed, factory);
  native.configure([config]); native.setTargets(scan); native.start();
  return { native, client, changed, factory, scan };
}

describe('optional existing-server native monitor', () => {
  it('does nothing without opt-in, and never reads unrelated server threads', async () => {
    const factory = vi.fn(() => new Client());
    native = new NativeMonitor('/home/test/.codex', vi.fn(), factory);
    native.setTargets(snapshot()); native.start();
    await vi.advanceTimersByTimeAsync(9000); expect(factory).not.toHaveBeenCalled();
    native.configure([config]); await vi.advanceTimersByTimeAsync(0);
    const client: Client = factory.mock.results[0]!.value;
    expect(client.request.mock.calls.every(([method]) => ['thread/loaded/list', 'thread/read'].includes(method))).toBe(true);
    expect(client.request).toHaveBeenCalledWith('thread/read', { threadId: uuid(0), includeTurns: false });
  });
  it('reflects initial waiting silently; alerts only a later confirmed non-waiting to waiting transition', async () => {
    const client = new Client(); client.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    const run = setup(client); await vi.advanceTimersByTimeAsync(0);
    expect(run.native.project(run.scan)?.sources[0]!.sessions[0]!.status).toBe('waiting');
    expect(run.changed.mock.calls.flatMap(([keys]) => keys)).toEqual([]);
    client.status = { type: 'active', activeFlags: [] }; await vi.advanceTimersByTimeAsync(3000);
    client.status = { type: 'active', activeFlags: ['waitingOnUserInput'] }; await vi.advanceTimersByTimeAsync(3000);
    expect(run.changed.mock.calls.flatMap(([keys]) => keys)).toEqual(['local:' + uuid(0)]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(run.changed.mock.calls.flatMap(([keys]) => keys)).toEqual(['local:' + uuid(0)]);
  });
  it('does not reread/sort or republish unchanged projected state', async () => {
    const run = setup(); await vi.advanceTimersByTimeAsync(0);
    const before = run.native.project(run.scan), revision = run.native.revision;
    run.changed.mockClear(); await vi.advanceTimersByTimeAsync(3000);
    expect(run.native.project(run.scan)).toBe(before); expect(run.native.revision).toBe(revision);
    expect(run.changed).not.toHaveBeenCalled();
    expect(run.client.request.mock.calls.filter(([method]) => method === 'thread/loaded/list')).toHaveLength(1);
  });
  it('regains authority after an identical fresh read following a newer file write', async () => {
    const run = setup(); await vi.advanceTimersByTimeAsync(0);
    const newer = snapshot(); newer.sources[0]!.capturedAt = NOW + 1;
    newer.sources[0]!.sessions[0]!.ageAtSourceMs = 0;
    run.native.setTargets(newer); expect(run.native.project(newer, NOW + 1)).toBe(newer);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run.native.project(newer)?.sources[0]!.sessions[0]!.nativeStatus?.state).toBe('active');
  });
  it('drops transport failure evidence, backs off, and reconnects without replaying pending events', async () => {
    const run = setup(); await vi.advanceTimersByTimeAsync(0);
    run.client.closed = true; run.client.fail = true;
    expect(run.native.project(run.scan)).toBe(run.scan);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run.native.health()[0]).toMatchObject({ state: 'degraded', reason: 'connection-unavailable', covered: 0, retries: 1 });
    run.client.fail = false; run.client.status = { type: 'active', activeFlags: ['waitingOnApproval'] };
    await vi.advanceTimersByTimeAsync(3999); expect(run.native.project(run.scan)).toBe(run.scan);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.native.project(run.scan)?.sources[0]!.sessions[0]!.status).toBe('waiting');
    expect(run.changed.mock.calls.flatMap(([keys]) => keys)).toEqual([]);
  });
  it('cancels disabled connections and rejects late in-flight responses', async () => {
    const run = setup(); let resolve: (value: unknown) => void = () => {};
    run.client.request.mockImplementation(async method => method === 'thread/loaded/list'
      ? { data: [uuid(0)], nextCursor: null }
      : new Promise(value => { resolve = value; }));
    await vi.advanceTimersByTimeAsync(0);
    run.native.configure([]); resolve({ thread: { id: uuid(0), status: { type: 'active', activeFlags: [] } } });
    await vi.advanceTimersByTimeAsync(9000);
    expect(run.native.project(run.scan)).toBe(run.scan); expect(run.client.close).toHaveBeenCalled();
    expect(run.native.health()).toEqual([]); expect(run.factory).toHaveBeenCalledTimes(1);
  });
  it('keeps matching source scope and never promotes unknown flags or unloaded threads', async () => {
    const run = setup(); run.client.status = { type: 'active', activeFlags: ['unrecognized'] };
    await vi.advanceTimersByTimeAsync(0); expect(run.native.project(run.scan)).toBe(run.scan);
    expect(run.native.health()[0]?.reason).toBe('protocol-unsupported');
    run.client.status = { type: 'notLoaded' }; await vi.advanceTimersByTimeAsync(3000);
    expect(run.native.project(run.scan)).toBe(run.scan);
    const offline = snapshot(); offline.sources[0]!.error = 'SECRET_SSH'; run.native.setTargets(offline);
    expect(run.native.health()[0]?.reason).toBe('source-unavailable');
    expect(run.client.close).toHaveBeenCalled();
  });
  it('paginates loaded IDs and fairly rotates the bounded 64-read batches', async () => {
    const client = new Client(); client.ids = Array.from({ length: 150 }, (_, i) => uuid(i));
    const run = setup(client, snapshot(150)); await vi.advanceTimersByTimeAsync(0);
    expect(client.request.mock.calls.filter(([method]) => method === 'thread/loaded/list')).toHaveLength(2);
    expect(client.request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(64);
    expect(run.native.health()[0]).toMatchObject({ loaded: 150, matched: 150, covered: 64, listComplete: true, reason: 'partial-coverage' });
    await vi.advanceTimersByTimeAsync(6000);
    const ids = new Set(client.request.mock.calls.filter(([method]) => method === 'thread/read').map(([, params]) => params?.threadId));
    expect(ids.size).toBe(150); expect(run.native.health()[0]?.covered).toBe(150);
  });
  it('removes evidence after TTL even without a new scan', async () => {
    const run = setup(); await vi.advanceTimersByTimeAsync(0);
    expect(run.native.project(run.scan)?.sources[0]!.sessions[0]!.nativeStatus).toBeDefined();
    expect(run.native.project(run.scan, NOW + 15001)).toBe(run.scan);
  });
  it('limits simultaneous metadata reads to four', async () => {
    const client = new Client(); client.ids = Array.from({ length: 20 }, (_, i) => uuid(i));
    const original = client.request.getMockImplementation()!;
    let active = 0, peak = 0;
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') {
        peak = Math.max(peak, ++active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
      }
      return original(method, params);
    });
    const run = setup(client, snapshot(20)); await vi.advanceTimersByTimeAsync(0);
    expect(peak).toBe(4); await vi.advanceTimersByTimeAsync(150);
    expect(active).toBe(0); expect(peak).toBe(4); expect(run.native.health()[0]?.covered).toBe(20);
  });
  it('terminates an overlong cycle and leaves no live state or leaked transport error', async () => {
    const client = new Client(), pending = new Set<(error: Error) => void>();
    client.request.mockImplementation(async method => method === 'thread/loaded/list'
      ? { data: [uuid(0)], nextCursor: null }
      : new Promise((_resolve, reject) => { pending.add(reject); }));
    client.close.mockImplementation(async () => {
      client.closed = true;
      for (const reject of pending) reject(new Error('SECRET_CONNECTION_FAILURE'));
      pending.clear();
    });
    const run = setup(client); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    expect(client.close).toHaveBeenCalled(); expect(pending.size).toBe(0);
    expect(run.native.project(run.scan)).toBe(run.scan);
    expect(run.native.health()[0]).toMatchObject({ state: 'degraded', reason: 'connection-unavailable', covered: 0 });
    expect(JSON.stringify(run.native.health())).not.toContain('SECRET');
  });
});


describe('adaptive read budget and optional passive wake hints', () => {
  it('reduces unchanged idle reads fourfold without extending the 15 s evidence lifetime', async () => {
    const client = new Client(); client.status = { type: 'idle' };
    const run = setup(client);
    await vi.advanceTimersByTimeAsync(0);
    const count = () => client.request.mock.calls.filter(([method]) => method === 'thread/read').length;
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(count()).toBe(2);
    expect(run.native.health()[0]).toMatchObject({ readRequests: 2 });
    // An artificial stale sample is not kept alive merely because its last
    // read was quiet; project() still uses the existing TTL.
    expect(run.native.project(run.scan, Date.now() + 15001)).toBe(run.scan);
  });

  it('keeps active/waiting reads at three seconds and slows idle loaded-list discovery', async () => {
    const client = new Client();
    const run = setup(client); await vi.advanceTimersByTimeAsync(9000);
    expect(client.request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(4);
    expect(client.request.mock.calls.filter(([method]) => method === 'thread/loaded/list')).toHaveLength(1);
    run.native.stop(); native = undefined;

    const quiet = new Client(); quiet.status = { type: 'idle' };
    setup(quiet); await vi.advanceTimersByTimeAsync(30_000);
    expect(quiet.request.mock.calls.filter(([method]) => method === 'thread/loaded/list')).toHaveLength(2);
    expect(quiet.request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(3);
  });

  it('gives active threads the fast lane without rereading idle neighbors each tick', async () => {
    const client = new Client();
    client.ids = [uuid(0), uuid(1)];
    const old = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === 'thread/read') return {
        thread: { id: params?.threadId, status: params?.threadId === uuid(0)
          ? { type: 'active', activeFlags: [] } : { type: 'idle' } },
      };
      return old(method, params);
    });
    setup(client, snapshot(2)); await vi.advanceTimersByTimeAsync(9000);
    const ids = client.request.mock.calls.filter(([method]) => method === 'thread/read')
      .map(([, params]) => params?.threadId);
    expect(ids.filter(id => id === uuid(0))).toHaveLength(4);
    expect(ids.filter(id => id === uuid(1))).toHaveLength(1);
  });

  it('treats exact-source passive status/turn hints only as an early read trigger', async () => {
    const client = new Client(), changed = vi.fn();
    let emit = (_hint: { method?: unknown; threadId?: unknown; serverRequestIgnored?: unknown }) => {};
    const factory = vi.fn((_endpoint: unknown, onEvent: typeof emit) => {
      emit = onEvent; return client;
    });
    native = new NativeMonitor('/home/test/.codex', changed, factory);
    const scan = snapshot(); native.configure([config]); native.setTargets(scan); native.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.project(scan)?.sources[0]?.sessions[0]?.status).toBe('working');
    client.status = { type: 'active', activeFlags: ['waitingOnUserInput'] };

    // The event itself never becomes authority (the read has not happened).
    emit({ method: 'thread/status/changed', threadId: uuid(0) });
    expect(native.project(scan)?.sources[0]?.sessions[0]?.status).toBe('working');
    await vi.advanceTimersByTimeAsync(149);
    expect(native.project(scan)?.sources[0]?.sessions[0]?.status).toBe('working');
    await vi.advanceTimersByTimeAsync(1);
    expect(native.project(scan)?.sources[0]?.sessions[0]?.status).toBe('waiting');
    expect(changed.mock.calls.flatMap(([keys]) => keys)).toEqual(['local:' + uuid(0)]);
    expect(native.health()[0]).toMatchObject({ readRequests: 2, passiveHints: 1 });
    expect(client.request.mock.calls.every(([method]) =>
      method === 'thread/read' || method === 'thread/loaded/list')).toBe(true);
  });

  it('ignores unrelated, malformed, server-request and old-generation hints', async () => {
    const client = new Client(), changed = vi.fn();
    let emit = (_hint: { method?: unknown; threadId?: unknown; serverRequestIgnored?: unknown }) => {};
    const factory = vi.fn((_endpoint: unknown, onEvent: typeof emit) => {
      emit = onEvent; return client;
    });
    native = new NativeMonitor('/home/test/.codex', changed, factory);
    native.configure([config]); native.setTargets(snapshot()); native.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = client.request.mock.calls.length;
    emit({ method: 'thread/status/changed', threadId: uuid(999) });
    emit({ method: 'item/tool/requestUserInput', threadId: uuid(0), serverRequestIgnored: true });
    emit({ method: 'thread/status/changed', threadId: 'BAD' });
    await vi.advanceTimersByTimeAsync(500);
    expect(client.request.mock.calls.length).toBe(before);
    expect(native.health()[0]?.passiveHints).toBe(0);
    native.configure([]);
    emit({ method: 'thread/status/changed', threadId: uuid(0) });
    await vi.advanceTimersByTimeAsync(500);
    expect(client.request.mock.calls.length).toBe(before);
  });

  it('wakes for a new filesystem observation instead of waiting for the idle timer', async () => {
    const client = new Client(); client.status = { type: 'idle' };
    const run = setup(client); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    client.status = { type: 'active', activeFlags: [] };
    const changed = snapshot();
    changed.sources[0]!.capturedAt = Date.now();
    changed.sources[0]!.sessions[0]!.ageAtSourceMs = 0;
    run.native.setTargets(changed);
    await vi.advanceTimersByTimeAsync(150);
    expect(client.request.mock.calls.filter(([method]) => method === 'thread/read')).toHaveLength(2);
    expect(run.native.project(changed)?.sources[0]?.sessions[0]?.status).toBe('working');
  });
});
