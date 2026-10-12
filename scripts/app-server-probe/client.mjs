import { connect as connectSocket } from 'node:net';
import { WebSocket } from 'ws';
import { READ_METHODS, summarizePush, summarizeThread } from './protocol.mjs';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export function parseProbeEndpoint({ socket, ws, allowRemote = false, home } = {}) {
  if (socket && ws) throw new Error('Choose either --socket or --ws, not both');
  if (ws) {
    let url;
    try { url = new URL(ws); } catch { throw new Error('Invalid --ws endpoint'); }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password ||
      url.hash || url.search || url.pathname !== '/') {
      throw new Error('Use a WebSocket URL with no credentials, query, or custom path');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!loopback && !allowRemote) {
      throw new Error('Remote WebSocket endpoints require --allow-remote; SSH forwarding to localhost is preferred');
    }
    if (url.protocol === 'ws:' && !loopback) {
      throw new Error('Refusing unencrypted non-loopback WebSocket (use a localhost SSH tunnel)');
    }
    return { kind: 'ws', url: url.href };
  }
  const base = home || process.env.CODEX_HOME;
  if (!socket && !base) throw new Error('A Codex home directory is required for default socket discovery');
  const endpoint = socket || base.replace(/[\\/]$/, '') + '/app-server-control/app-server-control.sock';
  if (!endpoint || !(/^(?:[A-Za-z]:[\\/]|[/\\]{2}|\/)/).test(endpoint)) {
    throw new Error('The socket path must be absolute');
  }
  return { kind: 'socket', path: endpoint };
}

export function connectExistingWebSocket(endpoint, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const params = { handshakeTimeout: timeoutMs, maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false, followRedirects: false };
  if (endpoint.kind === 'socket') {
    return new WebSocket('ws://localhost/', {
      ...params, createConnection: () => connectSocket({ path: endpoint.path }),
    });
  }
  if (endpoint.kind !== 'ws') throw new Error('Unsupported endpoint');
  return new WebSocket(endpoint.url, params);
}

export class AppServerProbeClient {
  constructor(endpoint, { onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS,
    showIds = false } = {}) {
    this.endpoint = endpoint;
    this.onEvent = onEvent;
    this.timeoutMs = timeoutMs;
    this.showIds = showIds;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stats = { pushEvents: 0, serverRequests: 0 };
    this.closed = false;
  }

  async start() {
    if (this.socket) throw new Error('Probe client already started');
    this.closed = false;
    const socket = connectExistingWebSocket(this.endpoint, this.timeoutMs);
    this.socket = socket;
    socket.on('message', bytes => this.receive(bytes));
    socket.on('close', () => { this.closed = true; this.rejectAll('Transport closed'); });
    socket.on('error', () => { /* reflected in start/request error without leaking host internals */ });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not connect to an existing App Server within the timeout')), this.timeoutMs);
        const opened = () => { clearTimeout(timer); socket.off('error', errored); resolve(); };
        const errored = () => { clearTimeout(timer); socket.off('open', opened);
          reject(new Error('Cannot connect to the existing App Server endpoint')); };
        socket.once('open', opened);
        socket.once('error', errored);
      });
      const response = await this.request('initialize', {
        clientInfo: { name: 'codex-monitor-readonly-probe', title: 'Codex Monitor Probe', version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      return response;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request(method, params = {}) {
    // Defense in depth: no resume, turn/start, approval, patch or config mutations.
    if (!READ_METHODS.has(method)) {
      throw new Error('Probe forbids non-read-only method: ' + String(method).slice(0, 100));
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.closed) {
      return Promise.reject(new Error('Probe is not connected'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Read-only request ' + method + ' timed out'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(new Error('Failed to send read-only request ' + method));
        }
      });
    });
  }

  receive(bytes) {
    let packet;
    try { packet = JSON.parse(bytes.toString('utf8')); } catch { return; }
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
    if (Object.hasOwn(packet, 'id') && !Object.hasOwn(packet, 'method')) {
      const callback = this.pending.get(packet.id);
      if (!callback) return;
      this.pending.delete(packet.id);
      clearTimeout(callback.timeout);
      if (packet.error) {
        const number = Number.isInteger(packet.error.code) ? packet.error.code : 'unknown';
        callback.reject(new Error('App Server rejected ' + callback.method + ' (code ' + number + ')'));
      } else callback.resolve(packet.result);
      return;
    }
    if (typeof packet.method !== 'string') return;
    if (Object.hasOwn(packet, 'id')) {
      // A read-only monitor must NEVER answer server-initiated input/approval
      // requests or impersonate the Codex user. Important for concurrent clients.
      this.stats.serverRequests++;
      const summary = summarizePush(packet, this.showIds);
      if (summary) this.onEvent({ ...summary, serverRequestIgnored: true });
      return;
    }
    this.stats.pushEvents++;
    const summary = summarizePush(packet, this.showIds);
    if (summary) this.onEvent(summary);
  }

  rejectAll(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async loadedThreads(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid loaded-thread limit');
    const ids = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < 10 && ids.length < limit; page++) {
      const result = await this.request('thread/loaded/list', { limit: Math.min(50, limit - ids.length), cursor });
      if (!result || !Array.isArray(result.data)) throw new Error('Unrecognized loaded-thread response');
      for (const id of result.data) {
        if (typeof id !== 'string' || id.length > 128 || !id || seen.has(id)) continue;
        ids.push(id);
        seen.add(id);
        if (ids.length >= limit) break;
      }
      const next = typeof result.nextCursor === 'string' ? result.nextCursor : null;
      if (!next || next === cursor || !result.data.length) break;
      cursor = next;
    }
    return ids;
  }

  async readStatus(threadId) {
    if (typeof threadId !== 'string' || !threadId || threadId.length > 128) throw new Error('Invalid thread ID');
    const result = await this.request('thread/read', { threadId, includeTurns: false });
    const thread = summarizeThread(result?.thread, this.showIds);
    if (!thread || typeof result.thread.id !== 'string' || result.thread.id !== threadId) {
      throw new Error('Missing or mismatched thread metadata');
    }
    return thread;
  }

  async close() {
    const socket = this.socket;
    this.socket = null;
    this.closed = true;
    this.rejectAll('Probe stopped');
    if (!socket) return;
    if (socket.readyState === WebSocket.CLOSED) return;
    socket.terminate();
  }
}
