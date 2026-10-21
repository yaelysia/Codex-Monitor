import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionRecord } from '../src/shared/types';
import { extractFirstUserTitle, extractSessionId, extractWorkspace, extractLastUserInputAt, inferStatus } from './rollout';
import { enrichLocalTitles } from './titles';
import { extractSessionClientKind, extractSessionOrigin } from '../src/shared/session-origin';
import { LocalScanCache } from '../src/shared/local-scan-cache';
import { indexedRollouts, localFileIndexDiagnostics, mapLimited } from './local-file-index';
import { MAX_PINNED_ROLLOUTS, validPinnedRolloutPath } from '../src/shared/pinned-rollouts';
import { readDesktopThreadHints, MAX_DESKTOP_EXTRA_ROLLOUTS } from './desktop-thread-index';

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 192 * 1024;
// Avoid rescanning full transcripts: only read further for recently modified,
// still-unknown sessions whose lifecycle markers left the short tail.
const EXTENDED_TAIL_BYTES = 8 * 1024 * 1024;
const VSCODE_QUESTION_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_VSCODE_QUESTION_LOOKBACKS = 8;
const RECENT_MS = 5 * 60_000;
const MAX_RETURNED = 200;
const cache = new LocalScanCache();
export function localScanCacheStats(): ReturnType<LocalScanCache['stats']> { return cache.stats(); }
const lastScanStats = new Map<string, {index: ReturnType<typeof localFileIndexDiagnostics>;
  parsed: number; cacheHits: number; cacheMisses: number;
  desktopIndexed: number; desktopExtraRollouts: number; desktopMetadataOnly: number }>();
export function localScanDiagnostics(root: string) { return lastScanStats.get(path.resolve(root)) ?? null; }

export function resolveLocalRoot(customRoot: string): string {
  const chosen = customRoot || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (chosen === '~') return os.homedir();
  if (chosen.startsWith('~/') || chosen.startsWith('~\\')) return path.join(os.homedir(), chosen.slice(2));
  return path.resolve(chosen);
}

/** Read bounded head/tail; never load a full historical transcript. */
async function readEdges(file: string, size: number): Promise<{ head: string; tail: string; clipped: boolean }> {
  const handle = await fs.open(file, 'r');
  try {
    const headLen = Math.min(HEAD_BYTES, size);
    const tailLen = Math.min(TAIL_BYTES, size);
    const head = Buffer.alloc(headLen);
    const tail = Buffer.alloc(tailLen);
    const [a, b] = await Promise.all([
      handle.read(head, 0, headLen, 0),
      handle.read(tail, 0, tailLen, size - tailLen),
    ]);
    return {
      head: head.subarray(0, a.bytesRead).toString('utf8'),
      tail: tail.subarray(0, b.bytesRead).toString('utf8'),
      clipped: size > tailLen,
    };
  } finally { await handle.close(); }
}

async function readExtendedTail(file: string, size: number,
  budget = EXTENDED_TAIL_BYTES): Promise<{ text: string; clipped: boolean }> {
  const length = Math.min(size, budget);
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const chunk = await handle.read(buffer, bytesRead, length - bytesRead, size - length + bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), clipped: size > length };
  } finally { await handle.close(); }
}

export async function scanLocal(root: string, sourceId = 'local',
  sourceLabel = 'Windows', now = Date.now(),
  pinnedPaths: readonly string[] = [], useIncrementalIndex = false): Promise<SessionRecord[]> {
  const sessionsDir = path.join(root, 'sessions');
  // Desktop may have multiple user-owned threads without a currently selected
  // recent rollout (especially paginated histories and busy subagent trees).
  // The existing SQLite index supplies only bounded metadata, never status.
  const desktop = sourceId === 'local' ? await readDesktopThreadHints(root) : [];
  const candidates = await indexedRollouts(root, now, useIncrementalIndex);
  const newest = candidates.slice(0, MAX_RETURNED);
  const included = new Set(newest.map(item => path.normalize(item.file)));
  const existingPins = [...new Set(pinnedPaths)]
    .filter(validPinnedRolloutPath).slice(0, MAX_PINNED_ROLLOUTS);
  // Do not let 200 newly active subagents evict another user's Desktop task.
  // Only append up to 32 verified extra files; no full transcript scanning.
  const dbPins = [...new Set(desktop.filter(thread => !thread.isSubagent)
    .map(thread => thread.relativePath).filter((value): value is string =>
      validPinnedRolloutPath(value) && !included.has(path.resolve(sessionsDir, ...value.split('/')))))]
    .slice(0, MAX_DESKTOP_EXTRA_ROLLOUTS);
  const extras = await mapLimited([...new Set([...existingPins, ...dbPins])], 8, async relative => {
    const file = path.resolve(sessionsDir, ...relative.split('/'));
    if (included.has(file)) return null;
    try {
      // A symlink under sessions must not redirect the pinned reader outside.
      const actual = await fs.realpath(file);
      const rel = path.relative(await fs.realpath(sessionsDir), actual);
      if (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) return null;
      const stat = await fs.stat(actual);
      if (!stat.isFile() || stat.size < 1) return null;
      included.add(file);
      return { file, mtime: stat.mtimeMs, size: stat.size };
    } catch { return null; }
  });
  const selected = [...newest, ...extras.filter((row): row is NonNullable<typeof row> => !!row)];
  const cacheBefore = cache.stats();
  let vscodeQuestionLookbacks = 0;
  const sessions = await mapLimited(selected, 12, async ({ file, mtime, size }): Promise<SessionRecord | null> => {
    try {
      const stored = cache.get(file, mtime, size, now);
      if (stored) return stored;
      const { head, tail, clipped } = await readEdges(file, size);
      const id = extractSessionId(head, file);
      const workspace = extractWorkspace(head, clipped ? tail.slice(tail.indexOf('\n') + 1) : tail);
      const origin = extractSessionOrigin(head);
      const clientKind = extractSessionClientKind(head);
      let inputTail = tail;
      let inputTailClipped = clipped;
      let state = inferStatus(tail, mtime, now, clipped);
      const newlyWritten = now - mtime >= -10_000 && now - mtime <= RECENT_MS;
      const fullRecovery = state.status === 'unknown' && clipped && newlyWritten;
      // A VS Code request may be buried behind >192 KiB of tool output while
      // the short tail still says "working" or "finished". Limit deeper reads
      // to eight recently modified VS Code rows per scan, and reuse the parse
      // cache on unchanged files.
      const vscodeRecovery = !fullRecovery && clientKind === 'vscode' && clipped &&
        newlyWritten && !state.pendingQuestionToken &&
        (state.status === 'working' || state.status === 'finished') &&
        vscodeQuestionLookbacks < MAX_VSCODE_QUESTION_LOOKBACKS;
      if (vscodeRecovery) vscodeQuestionLookbacks++;
      if (fullRecovery || vscodeRecovery) {
        const extended = await readExtendedTail(file, size,
          fullRecovery ? EXTENDED_TAIL_BYTES : VSCODE_QUESTION_TAIL_BYTES);
        state = inferStatus(extended.text, mtime, now, extended.clipped);
        inputTail = extended.text;
        inputTailClipped = extended.clipped;
      }
      const lastInputAt = extractLastUserInputAt(inputTail, inputTailClipped);
      const lastUserInputAgeAtSourceMs = lastInputAt == null ? null : now - lastInputAt;
      if (clientKind === 'desktop' && state.status === 'unknown') {
        state.statusReason += '；Desktop 的实时审批/提问信号可能未持久化，无法仅凭日志确认';
      }
      const record: SessionRecord = { key: `${sourceId}:${id}`, id, sourceId, sourceLabel, workspace,
        ...origin, clientKind, lastUserInputAgeAtSourceMs,
        lastUserInputAtSourceMs: lastInputAt,
        rolloutPath: path.relative(sessionsDir, file).split(path.sep).join('/'),
        title: extractFirstUserTitle(head), ...state, updatedAt: mtime, byteSize: size,
        ageAtSourceMs: now - mtime, startedAt: null };
      cache.put(file, mtime, size, record);
      return record;
    } catch { return null; } // rollover, deletion, permissions, partial writes
  });
  const seen = new Set<string>();
  const unique = sessions.filter((s): s is SessionRecord => {
    if (!s || seen.has(s.id.toLowerCase())) return false;
    seen.add(s.id.toLowerCase());
    return true;
  });
  // A Desktop thread indexed in SQLite but missing a readable rollout is a
  // visible UNKNOWN session, not a fabricated working/finished turn. Its
  // identity and origin are verified by Codex's own SQLite metadata.
  let desktopMetadataOnly = 0;
  for (const thread of desktop) {
    if (seen.has(thread.id)) continue;
    unique.push({
      id: thread.id, key: sourceId + ':' + thread.id, sourceId, sourceLabel,
      title: thread.title, workspace: thread.workspace, clientKind: 'desktop',
      isSubagent: thread.isSubagent, parentThreadId: thread.parentThreadId,
      rolloutPath: null, updatedAt: thread.updatedAt,
      ageAtSourceMs: now - thread.updatedAt, startedAt: null,
      status: 'unknown', statusReason:
        'Codex Desktop 已在本地线程索引中登记此任务，但暂未取得匹配的完整 JSONL 轮次证据；无法确认是否正在执行或已完成',
    });
    seen.add(thread.id);
    desktopMetadataOnly++;
  }
  cache.retain(new Set(selected.map(item => item.file)));
  await enrichLocalTitles(root, unique);
  const cacheAfter = cache.stats();
  const key = path.resolve(root);
  if (!lastScanStats.has(key) && lastScanStats.size >= 6)
    lastScanStats.delete(lastScanStats.keys().next().value!);
  lastScanStats.set(key, {
    index: localFileIndexDiagnostics(root), parsed: selected.length,
    cacheHits: cacheAfter.hits - cacheBefore.hits,
    cacheMisses: cacheAfter.misses - cacheBefore.misses,
    desktopIndexed: desktop.length,
    desktopExtraRollouts: extras.filter(x => !!x).length,
    desktopMetadataOnly,
  });
  return unique;
}
