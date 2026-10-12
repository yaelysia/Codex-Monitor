import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { AppServerProbeClient, parseProbeEndpoint } from '../scripts/app-server-probe/client.mjs';
import { summarizeStatus, summarizePush, summarizeThread } from '../scripts/app-server-probe/protocol.mjs';
import { parseArguments, runProbe } from '../scripts/probe-app-server.mjs';

const threadId = '019a1020-0000-7000-8000-111122223333';
const closed = [];
afterEach(async () => {
  for (const stop of closed.splice(0)) await stop();
});

function makeMockHandler(overrides = {}) {
  let reads = 0;
  const observed = [];
  const handler = (packet, ws) => {
    observed.push(packet);
    if (packet.method === 'initialize') {
      ws.send(JSON.stringify({ id: packet.id, result: { userAgent: 'mock/1.0' } }));
    } else if (packet.method === 'thread/loaded/list') {
      ws.send(JSON.stringify({ id: packet.id, result: {
        data: overrides.empty ? [] : [threadId], nextCursor: null,
      } }));
    } else if (packet.method === 'thread/read') {
      reads++;
      ws.send(JSON.stringify({ id: packet.id, result: { thread: {
        id: threadId, name: 'SECRET_PRIVATE_TITLE', cwd: '/PRIVATE_PATH',
        status: overrides.silent ? { type: 'idle' } :
          { type: 'active', activeFlags: reads > 1 ? ['waitingOnUserInput'] : [] },
        parentThreadId: null, turns: [
          { items: [{ type: 'reasoning', content: ['HIDDEN_MODEL_THOUGHT'] }] },
        ],
      } } }));
    } else if (packet.method === 'initialized') {
      /* Handshake notification is not a client command. */
    }
  };
  return { handler, observed, reads: () => reads };
}

async function mockServer(onMessage) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const connected = new Set();
  wss.on('connection', ws => {
    connected.add(ws);
    ws.on('message', bytes => {
      let packet;
      try { packet = JSON.parse(bytes.toString()); } catch { return; }
      onMessage(packet, ws);
    });
    ws.on('close', () => connected.delete(ws));
  });
  closed.push(async () => {
    for (const ws of connected) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
  });
  return { url: 'ws://127.0.0.1:' + wss.address().port + '/', connected };
}

test('flags are accurately projected; private transcript and question contents never printed', () => {
  assert.deepEqual(summarizeStatus({ type: 'active', activeFlags: [
    'waitingOnUserInput', 'waitingOnApproval', 'other',
  ] }), { state: 'active', flags: ['waitingOnUserInput', 'waitingOnApproval'] });
  assert.deepEqual(summarizeStatus({ type: 'idle', activeFlags: ['waitingOnApproval'] }),
    { state: 'idle', flags: [] });
  assert.deepEqual(summarizeStatus({ type: 'notLoaded' }),
    { state: 'notLoaded', flags: [] });
  assert.deepEqual(summarizeStatus({ type: 'systemError' }),
    { state: 'systemError', flags: [] });
  assert.deepEqual(summarizeStatus({ type: 'new-and-unknown' }),
    { state: 'unknown', flags: [] });

  const projected = summarizeThread({
    id: threadId, name: 'SUPERSECRET', cwd: 'SUPERSECRET', parentThreadId: threadId,
    turns: [{ items: [{ text: 'SUPERSECRET' }] }],
    status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  });
  assert.equal(projected.isSubagent, true);
  assert.equal(projected.id.includes(threadId), false);
  assert.equal(JSON.stringify(projected).includes('SUPERSECRET'), false);

  const event = summarizePush({ method: 'item/tool/requestUserInput', id: 'ask',
    params: { threadId, questions: [{ question: 'DO_NOT_PRINT_PRIVATE_QUESTION' }] } });
  assert.equal(event.pendingRequest, true);
  assert.equal(event.actionTaken, false);
  assert.equal(JSON.stringify(event).includes('DO_NOT_PRINT_PRIVATE_QUESTION'), false);
  assert.equal(summarizePush({ method: 'item/started', params: {
    threadId, item: { type: 'contextCompaction', content: 'DO_NOT_PRINT' },
  } }).itemType, 'contextCompaction');
  assert.equal(summarizePush({ method: 'turn/completed', params: {
    threadId, turn: { status: 'failed', error: { message: 'SECRET' } },
  } }).turnStatus, 'failed');
});

test('connection arguments reject unsafe sockets, credentials and cleartext remote endpoints', () => {
  assert.equal(parseProbeEndpoint({ home: '/tmp/test/.codex' }).path,
    '/tmp/test/.codex/app-server-control/app-server-control.sock');
  assert.deepEqual(parseProbeEndpoint({ ws: 'ws://127.0.0.1:4789/' }),
    { kind: 'ws', url: 'ws://127.0.0.1:4789/' });
  assert.throws(() => parseProbeEndpoint({ socket: 'relative.sock' }), /absolute/);
  assert.throws(() => parseProbeEndpoint({ socket: '/s', ws: 'ws://127.0.0.1:1234/' }), /either/);
  assert.throws(() => parseProbeEndpoint({ ws: 'ws://10.1.2.3:7000/' }), /allow-remote/);
  assert.throws(() => parseProbeEndpoint({ ws: 'ws://10.1.2.3:7000/', allowRemote: true }),
    /unencrypted/);
  assert.throws(() => parseProbeEndpoint({ ws: 'ws://alice:password@127.0.0.1:7000/' }),
    /credentials/);
  assert.throws(() => parseProbeEndpoint({ ws: 'ws://localhost:9000/other' }), /custom path/);
  assert.deepEqual(parseArguments(['--duration', '0', '--max-threads=2', '--show-ids']), {
    duration: 0, maxThreads: 2, pollMs: 2000,
    showIds: true, json: false, allowRemote: false,
  });
  assert.throws(() => parseArguments(['--duration', '999']), /between 0 and 120/);
  assert.throws(() => parseArguments(['--attach-thread', threadId]), /Unrecognized/);
});

test('probe supports actual WebSocket/JSON-RPC handshake and ONLY read-only methods', async () => {
  const { handler, observed } = makeMockHandler();
  const server = await mockServer(handler);
  const events = [];
  const client = new AppServerProbeClient({ kind: 'ws', url: server.url },
    { onEvent: event => events.push(event) });
  try {
    assert.throws(() => client.request('turn/start', {}), /forbids/);
    assert.throws(() => client.request('thread/resume', {}), /forbids/);
    assert.throws(() => client.request('config/value/write', {}), /forbids/);
    await client.start();
    assert.deepEqual(await client.loadedThreads(3), [threadId]);
    assert.deepEqual(await client.readStatus(threadId), {
      id: threadId.slice(0, 8) + '…' + threadId.slice(-4),
      status: { state: 'active', flags: [] }, isSubagent: false,
    });
    assert.ok(observed.every(packet =>
      ['initialize', 'initialized', 'thread/loaded/list', 'thread/read'].includes(packet.method)));
    assert.equal(observed.some(packet => packet.method === 'thread/resume'), false);
    assert.equal(observed.find(packet => packet.method === 'thread/read').params.includeTurns, false);
  } finally { await client.close(); }
});

test('passive push reception never answers a fake concurrent approval request', async () => {
  const originalResponses = [];
  const connections = [];
  const server = await mockServer((packet, socket) => {
    if (packet.method === 'initialize') socket.send(JSON.stringify({
      id: packet.id, result: { codexHome: '/SECRET_SERVER_HOME' },
    }));
    else if (packet.method === 'initialized') connections.push(socket);
    else if (packet.id === 'approval-1' && !packet.method) originalResponses.push(packet);
  });
  const original = new WebSocket(server.url);
  closed.push(async () => { if (original.readyState === WebSocket.OPEN) original.terminate(); });
  await new Promise(resolve => original.once('open', resolve));
  original.send(JSON.stringify({ method: 'initialize', id: 'original', params: {} }));
  original.on('message', data => {
    let packet;
    try { packet = JSON.parse(data.toString()); } catch { return; }
    if (packet.method === 'item/tool/requestUserInput') {
      original.send(JSON.stringify({ id: packet.id, result: { answers: {} } }));
    }
  });
  original.send(JSON.stringify({ method: 'initialized', params: {} }));

  const events = [];
  const client = new AppServerProbeClient({ kind: 'ws', url: server.url },
    { onEvent: event => events.push(event) });
  try {
    await client.start();
    const started = Date.now();
    while (connections.length < 2 && Date.now() - started < 1500) await sleep(15);
    assert.equal(connections.length, 2);
    for (const ws of connections) ws.send(JSON.stringify({
      method: 'item/tool/requestUserInput', id: 'approval-1',
      params: { threadId, questions: [{ question: 'never print answer contents' }] },
    }));
    await sleep(100);
    assert.equal(originalResponses.length, 1);
    assert.deepEqual(originalResponses[0].result, { answers: {} });
    assert.equal(client.stats.serverRequests, 1);
    assert.equal(events[0]?.serverRequestIgnored, true);
    assert.equal(events[0]?.actionTaken, false);
  } finally { await client.close(); }
});

test('CLI observes changing activeFlags by metadata reads, without subscribing or leaking text', async () => {
  const { handler, observed } = makeMockHandler();
  const server = await mockServer(handler);
  const lines = [];
  const result = await runProbe({
    ...parseArguments(['--duration', '2', '--poll-ms', '500', '--max-threads', '1', '--json']),
    ws: server.url,
  }, { write: line => lines.push(line) });
  assert.equal(result.connected, true);
  assert.equal(result.selected, 1);
  const json = lines.map(line => JSON.parse(line));
  assert.ok(json.some(e => e.type === 'thread' && e.status.state === 'active'));
  assert.ok(json.some(e => e.type === 'changed' && e.status.flags.includes('waitingOnUserInput')));
  assert.equal(json.some(e => e.subscribedExistingThreads === true), false);
  assert.equal(observed.some(event => event.method === 'thread/resume'), false);
  assert.equal(JSON.stringify(json).includes('SECRET_PRIVATE_TITLE'), false);
  assert.equal(JSON.stringify(json).includes('PRIVATE_PATH'), false);
  assert.equal(JSON.stringify(json).includes('HIDDEN_MODEL_THOUGHT'), false);
});

test('missing existing daemon socket is reported without launching Codex', async () => {
  const missing = path.join(os.tmpdir(), 'missing-codex-daemon-' + process.pid, 'no.sock');
  const lines = [];
  const result = await runProbe({
    ...parseArguments(['--duration', '0', '--json']), socket: missing,
  }, { write: line => lines.push(JSON.parse(line)) });
  assert.deepEqual(result, { connected: false, reason: 'no_existing_control_socket' });
  assert.equal(lines[0].code, 'no_existing_control_socket');
});

test('Unix-domain control socket uses WebSocket frames over existing local socket', async t => {
  if (process.platform === 'win32') {
    t.skip('Windows AF_UNIX support depends on Codex runtime and is exercised on a real host');
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-app-probe-'));
  closed.push(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const socket = path.join(dir, 'app-server-control.sock');
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    ws.on('message', bytes => {
      let request;
      try { request = JSON.parse(bytes.toString()); } catch { return; }
      if (request.method === 'initialize') ws.send(JSON.stringify({
        id: request.id, result: { userAgent: 'fake-local-uds' },
      }));
      if (request.method === 'thread/loaded/list') ws.send(JSON.stringify({
        id: request.id, result: { data: [threadId], nextCursor: null },
      }));
      if (request.method === 'thread/read') ws.send(JSON.stringify({
        id: request.id, result: { thread: { id: threadId,
          status: { type: 'active', activeFlags: ['waitingOnApproval'] }, parentThreadId: null } },
      }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  closed.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(() => server.close(resolve)));
  });
  const client = new AppServerProbeClient({ kind: 'socket', path: socket });
  try {
    await client.start();
    assert.equal((await client.loadedThreads(1))[0], threadId);
    assert.deepEqual((await client.readStatus(threadId)).status,
      { state: 'active', flags: ['waitingOnApproval'] });
  } finally { await client.close(); }
});
