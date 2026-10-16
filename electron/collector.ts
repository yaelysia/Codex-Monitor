import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { ScanResponse, SessionRecord, Settings, SourceKind, SourceResult } from '../src/shared/types';
import { resolveLocalRoot, scanLocal, localScanDiagnostics } from './local';
import { SessionActivityTracker } from '../src/shared/activity-tracker';
import { inspectDesktopLogSignals } from './desktop-runtime-logs';
import { applyDesktopLogEvidence, DesktopLogEventCache, isActiveDesktopStart,
  type DesktopLogEvent } from '../src/shared/desktop-log-status';
import { DesktopEvidenceStore } from './desktop-evidence-store';
import { validPinnedRolloutPath, MAX_PINNED_ROLLOUTS } from '../src/shared/pinned-rollouts';

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
const desktopLogCache = new DesktopLogEventCache();
/** Bounded ephemeral completion queue covers finish -> immediate new start,
 * which a latest-per-thread lifecycle map alone cannot represent.
 */
let completionQueue: DesktopLogEvent[] = [];
let desktopEvidenceStore: DesktopEvidenceStore | null = null;

/** Run once after Electron's app.whenReady(), before the first scan. */
export function configureDesktopEvidenceStorage(directory: string, now = Date.now()): void {
  if (process.platform !== 'win32' || desktopEvidenceStore) return;
  const store = new DesktopEvidenceStore(directory);
  desktopLogCache.restore(store.load(), now);
  desktopEvidenceStore = store;
}

export function flushDesktopEvidenceStorage(): void {
  desktopEvidenceStore?.flush();
}

/** Only trusted, parsed GUI completion metadata. Never exposes log text.
 * Historical starts/completions remain in the cache for ordering, but the
 * notification layer gates events to Monitor's current running lifetime.
 */
export function recentDesktopCompletions(now = Date.now()): DesktopLogEvent[] {
  const latest = desktopLogCache.snapshot(now);
  const unique = new Map<string, DesktopLogEvent>();
  for (const event of [...latest, ...completionQueue]) {
    if (event.type !== 'turn-displayed-complete' || !event.turnId ||
        now < event.at || now - event.at > 120_000) continue;
    unique.set(event.threadId + '/' + event.turnId, event);
  }
  return [...unique.values()];
}

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
export function runCollector(command: string, args: string[], python: string, root = '', options: Record<string, unknown> = {}): Promise<unknown> {
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
  const distros = await new Promise<string[] | null>((resolve) => {
    execFile('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer', timeout: 6_000, windowsHide: true }, (err, stdout) => {
      // A transient WSL listing error must not silently erase a previously
      // configured source. Keep the last known distros and let their own
      // scans expose a source error until WSL recovers.
      if (err || !stdout) return resolve(null);
      const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      const text = buffer.length > 1 && buffer[1] === 0 ? buffer.toString('utf16le') : buffer.toString('utf8');
      resolve([...new Set(text.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !isInternalWslDistro(s)))]);
    });
  });
  if (distros === null) return wslCache?.distros ?? [];
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
      interruptedToken: typeof entry.interruptedToken === 'string' ? entry.interruptedToken : null,
      interruptionTokens: Array.isArray(entry.interruptionTokens)
        ? [...new Set(entry.interruptionTokens.filter((token): token is string =>
          typeof token === 'string' && token.length > 0 && token.length <= 300))].slice(-32) : [],
      failedToken: typeof entry.failedToken === 'string' ? entry.failedToken.slice(0, 300) : null,
      failureTokens: Array.isArray(entry.failureTokens)
        ? [...new Set(entry.failureTokens.filter((token): token is string =>
          typeof token === 'string' && token.length > 0 && token.length <= 300))].slice(-32) : [],
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
  const started = performance.now();
  try {
    const sessions = await scan();
    return { id, label, kind, sessions, captureStartedAt, capturedAt: Date.now(),
      error: null, scanMetrics: { durationMs: Math.max(0, Math.round(performance.now() - started)),
        sessionCount: sessions.length } };
  } catch (error) {
    return { id, label, kind, sessions: [], captureStartedAt, capturedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      scanMetrics: {durationMs: Math.max(0, Math.round(performance.now() - started)),
        sessionCount: 0} };
  }
}

/** Sources complete independently. The callback is awaited per host so Monitor can
 * notify from a finished local/WSL source without waiting for slow SSH peers.
 * Results still retain the original stable source ordering on return.
 */
export async function refresh(settings: Settings, sourceIds?: ReadonlySet<string>,
  pinnedPaths: ReadonlyMap<string, readonly string[]> = new Map(),
  onSource?: (source: SourceResult) => void | Promise<void>,
  useIncrementalLocalIndex = false): Promise<ScanResponse> {
  const wanted = (id: string): boolean => !sourceIds || sourceIds.has(id);
  // Start local work immediately. WSL discovery and script I/O must not block
  // a ready local source's completion callback.
  const needsWsl = !sourceIds || [...sourceIds].some(id => id.startsWith('wsl:'));
  const distrosPromise = needsWsl ? listWslDistros() : Promise.resolve<string[]>([]);
  const scriptPromise = script().catch(() => '');
  const scans: Promise<SourceResult>[] = [];
  const add = (task: Promise<SourceResult>): void => {
    scans.push(task.then(async source => {
      inferObservedActivity([source], source.capturedAt ?? Date.now());
      await onSource?.(source);
      return source;
    }));
  };
  if (wanted('local')) add(sourceResult('local', 'Windows', 'local',
    () => scanLocal(resolveLocalRoot(settings.localRoot),
      'local', 'Windows', Date.now(), pinnedPaths.get('local') ?? [],
      useIncrementalLocalIndex)).then(source => {
        const stats = localScanDiagnostics(resolveLocalRoot(settings.localRoot));
        if (source.scanMetrics && stats) Object.assign(source.scanMetrics, {
          indexMode: stats.index.mode, indexedFiles: stats.index.indexedFiles,
          statCalls: stats.index.statCalls, parsedFiles: stats.cacheMisses,
          cacheHits: stats.cacheHits,
        });
        return source;
      }));
  const remoteScript = await scriptPromise;
  for (const host of settings.remotes) {
    const id = `ssh:${host.id}`;
    if (!wanted(id)) continue;
    const label = `${host.alias} · SSH`;
    add(sourceResult(id, label, 'ssh', async () => {
      if (!remoteScript) throw new Error('Collector script not found');
      const rows = await runCollector('ssh', [
        '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1',
        host.alias, 'python3', '-'
      ], remoteScript, host.root, { pinnedPaths: [...new Set(pinnedPaths.get(id) ?? [])]
        .filter(validPinnedRolloutPath).slice(0, MAX_PINNED_ROLLOUTS) });
      return normalizeRemote(rows, id, label);
    }));
  }
  const distros = await distrosPromise;
  for (const distro of distros) {
    const id = `wsl:${distro}`;
    if (!wanted(id)) continue;
    const label = `${distro} · WSL`;
    add(sourceResult(id, label, 'wsl', async () => {
      if (!remoteScript) throw new Error('Collector script not found');
      const pins = [...new Set(pinnedPaths.get(id) ?? [])].filter(validPinnedRolloutPath)
        .slice(0, MAX_PINNED_ROLLOUTS);
      const rows = await runCollector('wsl.exe', ['-d', distro, '--', 'python3', '-'],
        remoteScript, settings.wslRoots[distro] || '', { pinnedPaths: pins });
      return normalizeRemote(rows, id, label);
    }));
  }
  return { sources: await Promise.all(scans), scannedAt: Date.now() };
}

/** Overlay the Windows GUI's native lifecycle evidence over ANY known thread
 * with a matching UUID, including threads originally created by CLI or VS Code.
 * The original metadata is not mutated and remains suitable for later audits.
 */
export async function projectDesktopRuntime(
  snapshot: ScanResponse, now = Date.now(),
  dependencies: {
    platform?: NodeJS.Platform;
    inspect?: typeof inspectDesktopLogSignals;
    cache?: DesktopLogEventCache;
  } = {},
): Promise<ScanResponse> {
  if ((dependencies.platform ?? process.platform) !== 'win32' || !snapshot.sources.some(src =>
      !src.error && src.sessions.some(s => !s.isSubagent))) return snapshot;
  const inspected = await (dependencies.inspect ?? inspectDesktopLogSignals)(now).catch(() => ({
    events: new Map(), logFilesRead: 0, signalCount: 0,
    completions: [] as DesktopLogEvent[], discovery: null,
  }));
  const eventCache = dependencies.cache ?? desktopLogCache;
  const evidence = eventCache.observe(inspected.events, now);
  if (!dependencies.cache) {
    const unique = new Map<string, DesktopLogEvent>();
    for (const event of [...completionQueue, ...(inspected.completions ?? [])]) {
      if (event.type !== 'turn-displayed-complete' || !event.turnId ||
          now < event.at || now - event.at > 120_000) continue;
      unique.set(event.threadId + '/' + event.turnId, event);
    }
    completionQueue = [...unique.values()].slice(-128);
  }
  // Prevent a Monitor restart from losing an already observed accepted start
  // after Codex Desktop's verbose log rotates the original line away.
  if (!dependencies.cache) desktopEvidenceStore?.update(eventCache.snapshot(now));
  return {
    ...snapshot,
    sources: snapshot.sources.map(source => {
      if (source.error) return source;
      // Most CLI/WSL/SSH sessions have no native Desktop evidence.
      // Preserve their source/session references instead of cloning hundreds
      // of rows during every four-second native-log audit.
      const needsProjection = source.sessions.some(session => !session.isSubagent &&
        (evidence.has(session.id.toLowerCase()) ||
          (session.clientKind === 'desktop' && session.status === 'unknown')));
      if (!needsProjection) return source;
      const sessions = source.sessions.map(session => ({ ...session }));
      applyDesktopLogEvidence(sessions, evidence, now,
        source.capturedAt ?? snapshot.scannedAt,
        source.captureStartedAt ?? source.capturedAt ?? snapshot.scannedAt);
      for (const row of sessions) {
        // An exact GUI-owned UUID hit is evidence that Desktop, rather than
        // the recorded session creator, currently owns this thread.
        // Only a still-active GUI-owned turn is a CURRENT Desktop runtime.
        // A historical Desktop completion must not hijack an unrelated CLI
        // session's "return to window" link.
        const current = evidence.get(row.id.toLowerCase());
        if (!row.isSubagent && isActiveDesktopStart(current, now) &&
            row.status === 'working') row.desktopRuntimeObserved = true;
      }
      for (const row of sessions) {
        if (row.isSubagent || row.status !== 'unknown' ||
            (row.clientKind !== 'desktop' && !evidence.has(row.id.toLowerCase()))) continue;
        const detected = evidence.has(row.id.toLowerCase());
        const coverage = inspected.discovery;
        const detail = detected
          ? '已找到该会话的 Desktop 生命周期日志，但当前无法证实仍在运行'
          : coverage && !coverage.validLocalAppData
            ? '监控进程缺少 LOCALAPPDATA 环境变量，无法发现 Desktop 日志'
          : coverage && coverage.existingRootCount === 0
            ? '未找到已知的 Desktop 日志目录（普通安装/MSIX/Roaming）'
          : coverage && coverage.matchingLogNames === 0
            ? '已发现 Desktop 日志目录，但没有符合已知格式的日志文件'
          : coverage && coverage.recentCandidateCount === 0
            ? '找到 Desktop 日志文件，但文件时间或大小不在有限扫描范围内'
          : inspected.logFilesRead === 0
            ? '找到候选 Desktop 日志文件，但无法成功读取'
          : inspected.signalCount === 0
            ? 'Desktop 应用日志可读取，但未识别到支持的生命周期事件'
          : 'Desktop 应用日志可读取，但没有匹配当前会话 ID 的事件';
        row.statusReason += '；' + detail;
      }
      return { ...source, sessions };
    }),
  };
}
