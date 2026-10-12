#!/usr/bin/env node
/** One-command read-only diagnostics for Codex Desktop lifecycle and Moba tabs.
 * No session transcript, terminal contents, account data, tab captions or raw
 * log lines are printed. Not a real-time App Server subscription.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const LOG_NAME = /^codex-desktop-[a-z0-9._-]{1,175}\.log$/i;
const MAX_TAIL = 320 * 1024;
const MAX_TOTAL = 3 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function options(args) {
  const result = { duration: 0, threadId: null, skipMoba: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { result.help = true; continue; }
    if (args[i] === '--no-moba') { result.skipMoba = true; continue; }
    const [flag, inline] = args[i].split('=', 2);
    if (!['--duration', '--thread-id'].includes(flag))
      throw new Error('Unknown diagnostic option');
    const value = inline ?? args[++i];
    if (!value) throw new Error('Option value missing');
    if (flag === '--duration') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 45) throw new Error('Invalid duration');
      result.duration = n;
    } else if (!UUID.test(value)) throw new Error('Invalid thread UUID');
    else result.threadId = value.toLowerCase();
  }
  return result;
}

function dateDirectories(root, now) {
  const dates = [];
  for (const offset of [-2, -1, 0, 1]) {
    const d = new Date(now + offset * 86400_000);
    dates.push(path.join(root, String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')));
  }
  return dates;
}

async function logDirectories(localAppData, now) {
  if (!localAppData || !path.isAbsolute(localAppData)) return [];
  const roots = [path.join(localAppData, 'Codex', 'Logs')];
  try {
    const packages = await fs.readdir(path.join(localAppData, 'Packages'), { withFileTypes: true });
    for (const packageEntry of packages.slice(0, 150)) {
      if (packageEntry.isDirectory() && /^OpenAI\.Codex_[a-z0-9._-]+$/i.test(packageEntry.name)) {
        roots.push(path.join(localAppData, 'Packages', packageEntry.name,
          'LocalCache', 'Local', 'Codex', 'Logs'));
        if (roots.length >= 5) break;
      }
    }
  } catch {}
  return [...new Set(roots.flatMap(root => dateDirectories(root, now)))];
}

function candidate(line, now, target) {
  if (line.length > 10_000) return null;
  const timeMatch = /^(\S+)\s+(info|warning|error)\s+/.exec(line);
  const at = timeMatch ? Date.parse(timeMatch[1]) : NaN;
  if (!Number.isFinite(at) || now - at > 86400_000 || at > now + 5000) return null;
  const id = /\bconversationId=([0-9a-f-]{36})(?=\s|$)/i.exec(line)?.[1]?.toLowerCase();
  if (!id || !UUID.test(id) || (target && id !== target)) return null;
  let type;
  if (line.includes('[AppServerConnection]') && /\bresponse_routed\b/.test(line) &&
      /\bmethod=turn\/start(?=\s|$)/.test(line)) {
    type = /\berrorCode=null(?=\s|$)/.test(line) ? 'acceptedStart' : 'failedStart';
  } else if (line.includes('[desktop-notifications]') &&
      line.includes('show turn-complete')) type = 'turnCompleteNotice';
  else if (/Received turn\/(started|completed) for unknown conversation/.test(line))
    type = 'unknownConversation';
  else return null;
  return { at, type, id };
}

async function inspectLogs(root, now, target) {
  const dates = await logDirectories(root, now);
  const files = [];
  for (const date of dates.slice(0, 24)) {
    try {
      const rows = (await fs.readdir(date, { withFileTypes: true }))
        .filter(e => e.isFile() && LOG_NAME.test(e.name)).slice(0, 64);
      for (const entry of rows) {
        const file = path.join(date, entry.name);
        const stat = await fs.stat(file);
        if (stat.size > 0 && stat.size < 500 * 1024 * 1024 &&
            stat.mtimeMs > now - 86400_000) files.push({ file, size: stat.size, mtime: stat.mtimeMs });
      }
    } catch {}
  }
  files.sort((a,b)=>b.mtime-a.mtime);
  const counts = { acceptedStart: 0, failedStart: 0, turnCompleteNotice: 0, unknownConversation: 0 };
  const latest = { acceptedStart: null, turnCompleteNotice: null };
  const keys = new Set();
  let scannedFiles = 0;
  let byteBudget = MAX_TOTAL;
  for (const file of files.slice(0, 12)) {
    if (byteBudget <= 0) break;
    const size = Math.min(file.size, MAX_TAIL, byteBudget);
    let handle;
    try {
      handle = await fs.open(file.file, 'r');
      const buffer = Buffer.alloc(size);
      const {bytesRead} = await handle.read(buffer, 0, size, file.size-size);
      byteBudget -= bytesRead;
      scannedFiles++;
      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split(/\r?\n/);
      if (size < file.size) lines.shift();
      if (!chunk.endsWith('\n')) lines.pop();
      for (const line of lines) {
        const event = candidate(line, now, target);
        if (!event) continue;
        const unique = event.at + '|' + event.type + '|' + event.id;
        if (keys.has(unique)) continue;
        keys.add(unique);
        counts[event.type]++;
        if (event.type in latest)
          latest[event.type] = Math.max(latest[event.type] ?? 0, event.at);
      }
    } catch {} finally { await handle?.close().catch(()=>{}); }
  }
  return {
    filesExamined: scannedFiles, candidatesFound: files.length,
    events: counts,
    latestStartAgeSeconds: latest.acceptedStart == null
      ? null : Math.max(0, Math.round((now-latest.acceptedStart)/1000)),
    latestCompleteAgeSeconds: latest.turnCompleteNotice == null
      ? null : Math.max(0, Math.round((now-latest.turnCompleteNotice)/1000)),
    threadScoped: !!target,
  };
}

async function inspectMoba() {
  if (process.platform !== 'win32')
    return { available: false, reason: 'windows_only' };
  const command = path.join(path.dirname(fileURLToPath(import.meta.url)), '..',
    'collector', 'window-tracker.ps1');
  try {
    const { stdout } = await execAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', command, '-Mode', 'inspect-tabs',
    ], { timeout: 15_000, maxBuffer: 4096, windowsHide: true });
    const lines = stdout.split(/\r?\n/);
    const data = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(obj => obj?.type === 'tab-probe');
    if (!data) return { available: false, reason: 'native_probe_unavailable' };
    const allowed = (name, max = 1000) => Number.isInteger(data[name]) &&
      data[name] >= 0 && data[name] <= max ? data[name] : 0;
    return {
      available: true, identified: data.identified === true,
      provider: ['uia', 'msaa', 'none'].includes(data.provider) ? data.provider : 'none',
      reason: /^[a-z_]{1,80}$/.test(data.reason ?? '') ? data.reason : 'not_identified',
      count: allowed('count'),
      uiaTabItems: allowed('uiaTabItems'), msaaGroups: allowed('msaaGroups'),
      msaaMaxTabs: allowed('msaaMaxTabs'), msaaSelected: allowed('msaaSelected'),
      msaaDuplicateNames: data.msaaDuplicateNames === true,
      nativeTabLikeChildren: allowed('nativeTabLikeChildren'),
    };
  } catch { return { available: false, reason: 'probe_error_or_timeout' }; }
}

async function run(args) {
  const opts = options(args);
  if (opts.help) {
    console.log('npm run diagnose:tracking -- [--duration 15] [--thread-id UUID] [--no-moba]');
    return;
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const stopAt = Date.now() + opts.duration * 1000;
  let logSummary;
  do {
    logSummary = await inspectLogs(localAppData, Date.now(), opts.threadId);
    if (opts.duration === 0 || Date.now() >= stopAt) break;
    await sleep(Math.min(4000, Math.max(0, stopAt-Date.now())));
  } while (Date.now() < stopAt);
  const moba = opts.skipMoba ? { available: false, reason: 'skipped' } : await inspectMoba();
  console.log(JSON.stringify({ diagnosticVersion: 1, desktop: logSummary, moba }, null, 2));
}

run(process.argv.slice(2)).catch(() => {
  console.error('Tracking diagnostic could not complete (no raw data printed)');
  process.exitCode = 1;
});
