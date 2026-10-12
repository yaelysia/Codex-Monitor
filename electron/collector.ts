import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { ScanResponse, SessionRecord, Settings, SourceKind, SourceResult } from '../src/shared/types';
import { resolveLocalRoot, scanLocal } from './local';
import { SessionActivityTracker } from '../src/shared/activity-tracker';

const SCRIPT_TIMEOUT_MS = 18_000;
const MAX_STDOUT = 5 * 1024 * 1024;
let wslCache: { at: number; distros: string[] } | null = null;
let scriptCache: Promise<string> | null = null;

/** Docker Desktop's WSL distributions are internal infrastructure, not user workspaces. */
export function isInternalWslDistro(name: string): boolean {
  return /^docker-desktop(?:-data)?$/i.test(name.trim());
}

// Recent file growth is evidence of agent activity when lifecycle markers are
// outside our bounded scan window. Keep the observation transient and tentative.
const activityTracker = new SessionActivityTracker();

/** One shared activity timeline across Windows, WSL and SSH, without changing the file adapters. */
export function inferObservedActivity(sources: SourceResult[], now: number): void {
  activityTracker.annotate(sources, now);
}

function script(): Promise<string> {
  if (!scriptCache) {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'scan.py')
      : path.join(app.getAppPath(), 'collector', 'scan.py');
    scriptCache = fs.readFile(file, 'utf8').catch((error) => { scriptCache = null; throw error; });
  }
  return scriptCache;
}

/** Process args are fixed; only a trusted base64 JSON literal is prepended to Python stdin. */
export function runCollector(command: string, args: string[], python: string, root = '', options: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let output = '';
    let errorText = '';
    let completed = false;
    let timedOut = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, SCRIPT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_STDOUT) child.kill();
    });
    child.stderr.on('data', (chunk: string) => { errorText = (errorText + chunk).slice(-2048); });
    const finish = (failure?: Error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error(`Invalid scanner output: ${errorText || output.slice(0, 200)}`)); }
    };
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (code !== 0) { finish(new Error(timedOut ? 'Collector timed out' : errorText.trim() || `Collector exited with code ${code}`)); return; }
      finish();
    });
    const config = Buffer.from(JSON.stringify({ root, limit: 200, ...options }), 'utf8').toString('base64');
    child.stdin.on('error', () => { /* process exited early; close event reports the failure */ });
    child.stdin.end(`CONFIG_B64 = '${config}'\n${python}`);
  });
}

export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  if (wslCache && Date.now() - wslCache.at < 60_000) return wslCache.distros;
  const distros = await new Promise<string[]>((resolve) => {
    execFile('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer', timeout: 6_000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      const text = buffer.length > 1 && buffer[1] === 0 ? buffer.toString('utf16le') : buffer.toString('utf8');
      resolve([...new Set(text.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !isInternalWslDistro(s)))]);
    });
  });
  wslCache = { at: Date.now(), distros };
  return distros;
}

export function normalizeRemote(rows: unknown, id: string, label: string): SessionRecord[] {
  if (!Array.isArray(rows)) throw new Error('Scanner output must be an array');
  const seen = new Set<string>();
  const sessions: SessionRecord[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.updatedAt !== 'number' ||
        !Number.isFinite(entry.updatedAt) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const status = entry.status;
    sessions.push({
      id: entry.id,
      key: `${id}:${entry.id}`,
      sourceId: id,
      sourceLabel: label,
      workspace: typeof entry.workspace === 'string' ? entry.workspace : null,
      isSubagent: entry.isSubagent === true,
      parentThreadId: typeof entry.parentThreadId === 'string' ? entry.parentThreadId : null,
      clientKind: entry.clientKind === 'desktop' || entry.clientKind === 'vscode' ||
        entry.clientKind === 'terminal' ? entry.clientKind : 'unknown',
      lastUserInputAgeAtSourceMs: typeof entry.lastUserInputAgeAtSourceMs === 'number' &&
        Number.isFinite(entry.lastUserInputAgeAtSourceMs) ? entry.lastUserInputAgeAtSourceMs : null,
      lastUserInputAtSourceMs: typeof entry.lastUserInputAtSourceMs === 'number' &&
        Number.isFinite(entry.lastUserInputAtSourceMs) ? entry.lastUserInputAtSourceMs : null,
      rolloutPath: typeof entry.rolloutPath === 'string' ? entry.rolloutPath : null,
      title: typeof entry.title === 'string' && entry.title.trim() ? entry.title.slice(0, 181) : null,
      status: status === 'working' || status === 'waiting' || status === 'finished' ||
        status === 'interrupted' || status === 'failed' ? status : 'unknown',
      statusReason: typeof entry.statusReason === 'string' ? entry.statusReason : '状态信息不足',
      finishedToken: typeof entry.finishedToken === 'string' ? entry.finishedToken : null,
      waitingToken: typeof entry.waitingToken === 'string' ? entry.waitingToken : null,
      pendingQuestionToken: typeof entry.pendingQuestionToken === 'string' ?
        entry.pendingQuestionToken.slice(0, 300) : null,
      questionText: typeof entry.questionText === 'string' ? entry.questionText.slice(0, 160) : null,
      updatedAt: entry.updatedAt,
      byteSize: typeof entry.byteSize === 'number' && Number.isFinite(entry.byteSize) ? entry.byteSize : undefined,
      ageAtSourceMs: typeof entry.ageAtSourceMs === 'number' && Number.isFinite(entry.ageAtSourceMs)
        ? entry.ageAtSourceMs : undefined,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
    });
  }
  return sessions;
}

async function sourceResult(id: string, label: string, kind: SourceKind, scan: () => Promise<SessionRecord[]>): Promise<SourceResult> {
  const captureStartedAt = Date.now();
  try { return { id, label, kind, sessions: await scan(), captureStartedAt, capturedAt: Date.now(), error: null }; }
  catch (error) { return { id, label, kind, sessions: [], captureStartedAt, capturedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error) }; }
}

/** Passing sourceIds scans only the changed host; empty/omitted means all hosts. */
export async function refresh(settings: Settings, sourceIds?: ReadonlySet<string>): Promise<ScanResponse> {
  const wanted = (id: string): boolean => !sourceIds || sourceIds.has(id);
  const distros = await listWslDistros();
  const remoteScript = await script().catch(() => '');
  const scans: Promise<SourceResult>[] = [];
  if (wanted('local')) scans.push(sourceResult('local', 'Windows', 'local',
    () => scanLocal(resolveLocalRoot(settings.localRoot))));
  for (const distro of distros) {
    const id = `wsl:${distro}`;
    if (!wanted(id)) continue;
    const label = `${distro} · WSL`;
    scans.push(sourceResult(id, label, 'wsl', async () => {
      if (!remoteScript) throw new Error('Collector script not found');
      const rows = await runCollector('wsl.exe', ['-d', distro, '--', 'python3', '-'], remoteScript, settings.wslRoots[distro] || '');
      return normalizeRemote(rows, id, label);
    }));
  }
  for (const host of settings.remotes) {
    const id = `ssh:${host.id}`;
    if (!wanted(id)) continue;
    const label = `${host.alias} · SSH`;
    scans.push(sourceResult(id, label, 'ssh', async () => {
      if (!remoteScript) throw new Error('Collector script not found');
      const rows = await runCollector('ssh', [
        '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
        host.alias, 'python3', '-'
      ], remoteScript, host.root);
      return normalizeRemote(rows, id, label);
    }));
  }
  const sources = await Promise.all(scans);
  const scannedAt = Date.now();
  inferObservedActivity(sources, scannedAt);
  return { sources, scannedAt };
}
