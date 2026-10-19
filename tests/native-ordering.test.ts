import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeMonitor, type NativeClient } from '../electron/native-monitor';
import type { ScanResponse } from '../src/shared/types';
const NOW = 1_800_000_000_000;
const id = '019a1020-0000-7000-8000-777788889999', key = 'local:' + id;
function scan(at = NOW, age = 1000): ScanResponse {
  return { scannedAt: at, sources: [{ id: 'local', label: 'Local', kind: 'local', error: null,
    capturedAt: at, sessions: [{ id, key, sourceId: 'local', sourceLabel: 'Local', title: 'Task',
      workspace: null, status: 'unknown', statusReason: 'log', updatedAt: at - age,
      ageAtSourceMs: age, startedAt: null }] }] };
}
let monitor: NativeMonitor | undefined;
afterEach(() => { monitor?.stop(); monitor = undefined; vi.useRealTimers(); });

describe('ordering native pending evidence against source scans', () => {
  it('does not consume an ineligible waiting observation before the next authoritative read', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    let waiting = false, delayed = false;
    const client: NativeClient = {
      closed: false, stats: { serverRequests: 0 }, start: async () => {},
      close: async () => { client.closed = true; },
      request: async (method, params) => {
        if (method === 'thread/loaded/list') return { data: [id], nextCursor: null };
        expect(method).toBe('thread/read'); expect(params?.includeTurns).toBe(false);
        if (delayed) await new Promise(resolve => setTimeout(resolve, 100));
        return { thread: { id, status: { type: 'active', activeFlags: waiting ? ['waitingOnUserInput'] : [] } } };
      },
    };
    const notifications: string[] = [];
    monitor = new NativeMonitor('/home/test/.codex', keys => notifications.push(...keys), () => client);
    monitor.configure([{ sourceId: 'local', enabled: true, transport: 'ws', endpoint: 'ws://127.0.0.1:1234/' }]);
    monitor.setTargets(scan()); monitor.start(); await vi.advanceTimersByTimeAsync(0);
    waiting = delayed = true;
    await vi.advanceTimersByTimeAsync(3001);
    const newer = scan(NOW + 3001, 0); monitor.setTargets(newer);
    await vi.advanceTimersByTimeAsync(99);
    expect(monitor.project(newer)).toBe(newer);
    expect(notifications).toEqual([]);
    delayed = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(monitor.project(newer)?.sources[0]!.sessions[0]!.status).toBe('waiting');
    expect(notifications).toEqual([key]);
  });
});
