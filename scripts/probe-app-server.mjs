#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppServerProbeClient, parseProbeEndpoint } from './app-server-probe/client.mjs';

const DEFAULTS = { duration: 20, pollMs: 2000, maxThreads: 15, showIds: false,
  json: false, allowRemote: false };
function numberFlag(raw, name, min, max) {
  const number = Number(raw);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return number;
}
export function parseArguments(args) {
  const parsed = { ...DEFAULTS };
  const flags = new Map([
    ['--socket', 'socket'], ['--ws', 'ws'], ['--duration', 'duration'],
    ['--poll-ms', 'pollMs'], ['--max-threads', 'maxThreads'],
  ]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
    if (arg === '--show-ids') { parsed.showIds = true; continue; }
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--allow-remote') { parsed.allowRemote = true; continue; }
    const matched = arg.split('=', 2);
    const key = flags.get(matched[0]);
    if (!key) throw new Error('Unrecognized probe option: ' + String(arg).slice(0, 80));
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
    if (typeof value !== 'string' || !value) throw new Error('Missing value for ' + arg);
    parsed[key] = value;
  }
  parsed.duration = numberFlag(parsed.duration, '--duration', 0, 120);
  parsed.pollMs = numberFlag(parsed.pollMs, '--poll-ms', 500, 30_000);
  parsed.maxThreads = numberFlag(parsed.maxThreads, '--max-threads', 1, 50);
  return parsed;
}
function showHelp() {
  return [
    'Codex Monitor: independent read-only App Server probe',
    '',
    '  npm run probe:app-server -- [--duration 20] [--max-threads 15]',
    '  npm run probe:app-server -- --socket PATH',
    '  npm run probe:app-server -- --ws ws://127.0.0.1:PORT/',
    '',
    'Options:',
    '  --duration N      0 = one snapshot; otherwise observe for N seconds (max 120)',
    '  --poll-ms N       Snapshot interval in ms, default 2000 (min 500)',
    '  --max-threads N   Max loaded threads to inspect, default 15 (max 50)',
    '  --show-ids        Print full thread IDs for matching with Monitor sessions',
    '  --json            One sanitized JSON object per line',
    '  --allow-remote    Opt in to explicit non-loopback TLS (wss://) connections',
    '',
    'Never starts a new Codex service, resumes threads, changes configuration,',
    'answers questions, or modifies the existing Codex Monitor notification pipeline.',
    'If the default socket is absent, use --socket or connect to an already',
    'running shared server with --ws (SSH port forwarding recommended).',
  ].join('\n');
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function printer(opts, write) {
  return (type, fields) => {
    const row = { type, ...fields };
    if (opts.json) write(JSON.stringify(row));
    else if (type === 'thread') {
      write('  ' + row.id + ' · ' + row.status.state +
        (row.status.flags.length ? ' [' + row.status.flags.join(', ') + ']' : '') +
        (row.isSubagent ? ' · subagent' : ''));
    } else if (type === 'push') {
      write('  EVENT ' + row.method + ' · ' + (row.threadId || 'unknown') +
        (row.status ? ' ' + row.status.state + ' ' + row.status.flags.join(',') : '') +
        (row.serverRequestIgnored ? ' · ignored without response' : ''));
    } else if (type === 'changed') {
      write('  CHANGED ' + row.id + ' · ' + row.status.state +
        (row.status.flags.length ? ' [' + row.status.flags.join(', ') + ']' : ''));
    } else if (type === 'error') write('  WARNING ' + row.code);
    else if (type === 'summary') write('  SUMMARY ' + JSON.stringify(fields));
    else write('  ' + type.toUpperCase() + ' ' + JSON.stringify(fields));
  };
}

/** This function has no persistence, log access, thread mutations or auto-discovery
 * through process arguments. Every observation is scoped to an existing endpoint.
 */
export async function runProbe(options, { write = console.log, clientFactory } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const endpoint = parseProbeEndpoint({
    socket: opts.socket, ws: opts.ws, allowRemote: opts.allowRemote,
    home: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  });
  const emit = printer(opts, write);
  if (endpoint.kind === 'socket') {
    try {
      const stat = await fs.stat(endpoint.path);
      // Windows AF_UNIX may be represented differently, but a missing path
      // must never trigger creation of a new app-server.
      if (!stat.isSocket() && process.platform !== 'win32') throw new Error('Not a Unix socket');
    } catch {
      emit('error', { code: 'no_existing_control_socket',
        next: 'Use --socket PATH or --ws ws://127.0.0.1:PORT/ for an existing shared server' });
      return { connected: false, reason: 'no_existing_control_socket' };
    }
  }
  const client = clientFactory
    ? clientFactory(endpoint, { onEvent: event => emit('push', event), showIds: opts.showIds })
    : new AppServerProbeClient(endpoint,
      { onEvent: event => emit('push', event), showIds: opts.showIds });
  const stats = { connected: false, selected: 0, statusUpdates: 0,
    pendingUserInput: 0, pendingApproval: 0, methodScope: 'metadata-only' };
  let previous = new Map();
  let threadIds = [];
  try {
    await client.start();
    stats.connected = true;
    emit('connected', { endpoint: endpoint.kind, serverStartedByProbe: false,
      subscribedExistingThreads: false, mode: 'read-only-snapshots' });
    const deadline = Date.now() + opts.duration * 1000;
    let nextListAt = 0;
    let first = true;
    do {
      const now = Date.now();
      if (first || now >= nextListAt) {
        try { threadIds = await client.loadedThreads(opts.maxThreads); }
        catch {
          emit('error', { code: 'thread_loaded_list_unavailable',
            next: 'This endpoint may use an older Codex protocol; no resume attempted' });
          break;
        }
        nextListAt = Date.now() + 10_000;
        stats.selected = threadIds.length;
        if (first) emit('discovered', { loadedCount: threadIds.length,
          note: 'Only threads loaded by this SAME App Server are visible' });
      }
      for (const id of threadIds) {
        let row;
        try { row = await client.readStatus(id); }
        catch {
          emit('error', { code: 'thread_read_unavailable_or_unloaded' });
          continue;
        }
        const signature = JSON.stringify([row.status.state, row.status.flags, row.isSubagent]);
        if (previous.get(id) !== signature) {
          emit(first ? 'thread' : 'changed', row);
          stats.statusUpdates++;
        }
        previous.set(id, signature);
        if (row.status.flags.includes('waitingOnUserInput')) stats.pendingUserInput++;
        if (row.status.flags.includes('waitingOnApproval')) stats.pendingApproval++;
      }
      first = false;
      const untilNext = deadline - Date.now();
      if (opts.duration === 0 || untilNext <= 0) break;
      await sleep(Math.min(opts.pollMs, untilNext));
    } while (Date.now() < deadline);
    emit('summary', {
      connected: true, loaded: stats.selected, statusUpdates: stats.statusUpdates,
      receivedPushEvents: client.stats.pushEvents,
      ignoredServerRequests: client.stats.serverRequests,
      nativeSubscription: false, daemonCreated: false,
    });
    return stats;
  } finally {
    await client.close();
  }
}

async function main(args = process.argv.slice(2)) {
  const opts = parseArguments(args);
  if (opts.help) { console.log(showHelp()); return; }
  const result = await runProbe(opts);
  if (!result.connected) process.exitCode = 2;
}

const launchedDirectly = process.argv[1] && import.meta.url === new URL('file://' +
  (process.platform === 'win32' ? '/' : '') + path.resolve(process.argv[1]).replace(/\\/g, '/')).href;
if (launchedDirectly) {
  main().catch(error => {
    console.error('Probe failed: ' + (error instanceof Error ? error.message : 'unknown error'));
    process.exitCode = 1;
  });
}
