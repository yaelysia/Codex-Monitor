import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { NativeMonitor } from '../electron/native-monitor';
import type { ScanResponse, SessionRecord } from '../src/shared/types';
const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new (options: object) => any };

const ids = [
  '019a1020-0000-7000-8000-000000000001',
  '019a1020-0000-7000-8000-000000000002',
];
let monitor: NativeMonitor | null = null;
const servers: any[] = [];
afterEach(async () => {
  monitor?.stop(); monitor = null;
  for (const server of servers.splice(0)) {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
async function serve(id: string, flags: string[]): Promise<{ endpoint: string; methods: string[] }> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const methods: string[] = [];
  server.on('connection', (peer: any) => peer.on('message', (buffer: Buffer) => {
    const packet = JSON.parse(buffer.toString('utf8')) as { id?: number; method: string };
    methods.push(packet.method);
    if (packet.id === undefined) return;
    const result = packet.method === 'initialize' ? { serverInfo: { name: 'test', version: '0' } }
      : packet.method === 'thread/loaded/list' ? { data: [id], nextCursor: null }
      : packet.method === 'thread/read' ? { thread: { id, status: { type: 'active', activeFlags: flags } } }
      : null;
    if (result === null) throw new Error('Unexpected non-read operation');
    peer.send(JSON.stringify({ id: packet.id, result }));
  }));
  return { endpoint: 'ws://127.0.0.1:' + (server.address() as { port: number }).port + '/', methods };
}
function snapshot(): ScanResponse {
  const now = Date.now();
  return { scannedAt: now, sources: [{ id: 'local', label: 'Local', kind: 'local', error: null,
    capturedAt: now, sessions: ids.map((id): SessionRecord => ({
      id, key: 'local:' + id, sourceId: 'local', sourceLabel: 'Local',
      title: 'redacted', workspace: null, status: 'unknown', statusReason: 'log',
      updatedAt: now - 1000, ageAtSourceMs: 1000, startedAt: null,
    })) }] };
}
async function until(done: () => boolean): Promise<void> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > 4000) throw new Error('No complete coverage from existing endpoints');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
describe('real same-source multi-App-Server WebSocket coverage', () => {
  it('joins distinct loaded threads by UUID and preserves the read-only method whitelist', async () => {
    const first = await serve(ids[0]!, []);
    const second = await serve(ids[1]!, ['waitingOnApproval']);
    const scan = snapshot(), changes: string[] = [];
    monitor = new NativeMonitor('/not-used', keys => changes.push(...keys));
    monitor.configure([first, second].map(x => ({
      sourceId: 'local', transport: 'ws' as const, endpoint: x.endpoint, enabled: true,
    })));
    monitor.setTargets(scan); monitor.start();
    await until(() => monitor!.health().every(x => x.covered === 1));
    expect(monitor.project(scan)?.sources[0]?.sessions.map(x => x.status)).toEqual(['working','waiting']);
    expect(changes).toEqual([]); // First read is a silent baseline, even on the second endpoint.
    for (const { methods } of [first, second]) {
      expect(methods).toContain('thread/read');
      expect(methods.every(method =>
        ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'].includes(method))).toBe(true);
    }
  }, 10000);
});
