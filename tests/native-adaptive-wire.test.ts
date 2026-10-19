import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
// The app already depends on ws at runtime; don't introduce a new @types/ws dependency.
const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new (options: object) => any };
import { NativeMonitor } from '../electron/native-monitor';
import type { ScanResponse } from '../src/shared/types';

const ID = '019a1020-0000-7000-8000-111122223333';
const KEY = 'local:' + ID;
function snapshot(): ScanResponse {
  const now = Date.now();
  return { scannedAt: now, sources: [{ id: 'local', label: 'Local', kind: 'local',
    error: null, capturedAt: now,
    sessions: [{ id: ID, key: KEY, sourceId: 'local', sourceLabel: 'Local', title: 'safe',
      workspace: null, startedAt: null, status: 'unknown', statusReason: 'log',
      updatedAt: now - 1000, ageAtSourceMs: 1000 }] }] };
}
async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for test status');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

let monitor: NativeMonitor | null = null;
let server: any = null;
afterEach(async () => {
  monitor?.stop(); monitor = null;
  if (server) {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;
  }
});

describe('actual passive App Server WebSocket to native scheduling', () => {
  it('validates hints using thread/read; never writes/approves/subscribes', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const outgoing: string[] = [];
    const clientSockets = new Set<any>();
    let reads = 0;
    let status: { type: 'active'; activeFlags: string[] } = { type: 'active', activeFlags: [] };
    server.on('connection', (peer: any) => {
      clientSockets.add(peer);
      peer.on('close', () => clientSockets.delete(peer));
      peer.on('message', (buffer: Buffer) => {
        const packet = JSON.parse(buffer.toString('utf8')) as { id?: number; method: string };
        outgoing.push(packet.method);
        if (packet.id === undefined) return;
        let result: unknown;
        if (packet.method === 'initialize') result = { serverInfo: { name: 'fake', version: '0' } };
        else if (packet.method === 'thread/loaded/list') result = { data: [ID], nextCursor: null };
        else if (packet.method === 'thread/read') {
          reads++;
          result = { thread: { id: ID, status, source: 'cli' } };
        } else throw new Error('Unexpected read method: ' + packet.method);
        peer.send(JSON.stringify({ id: packet.id, result }));
      });
    });
    const emitted: string[] = [], scan = snapshot();
    monitor = new NativeMonitor('/mock/.codex', keys => emitted.push(...keys));
    monitor.configure([{ sourceId: 'local', enabled: true, transport: 'ws',
      endpoint: 'ws://127.0.0.1:' + port + '/' }]);
    monitor.setTargets(scan); monitor.start();
    await until(() => monitor?.project(scan)?.sources[0]?.sessions[0]?.status === 'working');
    expect(reads).toBe(1);
    const firstSuccess = monitor.health()[0]?.lastSuccessAt ?? 0;

    const publish = (params: Record<string, unknown>) => {
      for (const peer of clientSockets) peer.send(JSON.stringify({
        method: 'thread/status/changed', params: { threadId: ID, ...params } }));
    };
    // A fabricated push cannot override a real read, even when its flags
    // claim waiting. The server still reads as active without flags.
    publish({ status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
    await until(() => (monitor?.health()[0]?.lastSuccessAt ?? 0) > firstSuccess);
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(monitor.project(scan)?.sources[0]?.sessions[0]?.status).toBe('working');
    expect(emitted).toEqual([]);

    status = { type: 'active', activeFlags: ['waitingOnUserInput'] };
    publish({ status: { type: 'active', activeFlags: ['waitingOnUserInput'] } });
    await until(() => emitted.length === 1);
    expect(emitted).toEqual([KEY]);
    expect(monitor.project(scan)?.sources[0]?.sessions[0]?.status).toBe('waiting');

    // The server can ask the probe for approval, but the probe must neither
    // reply nor run a write operation.
    for (const peer of clientSockets) peer.send(JSON.stringify({
      id: 812, method: 'item/tool/requestUserInput',
      params: { threadId: ID, questions: ['PRIVATE_QUESTION'] },
    }));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(outgoing.every(method => ['initialize', 'initialized',
      'thread/loaded/list', 'thread/read'].includes(method))).toBe(true);
    expect(monitor.health()[0]?.passiveHints).toBe(2);
  }, 10000);
});
