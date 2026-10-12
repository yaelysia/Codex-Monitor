import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionRecord } from '../src/shared/types';
import { extractFirstUserTitle, extractSessionId, extractWorkspace, extractLastUserInputAt, inferStatus } from './rollout';
import { enrichLocalTitles } from './titles';
import { extractSessionClientKind, extractSessionOrigin } from '../src/shared/session-origin';
import { LocalScanCache } from '../src/shared/local-scan-cache';

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 192 * 1024;
// Avoid rescanning full transcripts: only read further for recently modified,
// still-unknown sessions whose lifecycle markers left the short tail.
const EXTENDED_TAIL_BYTES = 8 * 1024 * 1024;
const RECENT_MS = 5 * 60_000;
const MAX_DISCOVERED = 10_000;
const MAX_RETURNED = 200;
const cache = new LocalScanCache();
export function localScanCacheStats(): ReturnType<LocalScanCache['stats']> { return cache.stats(); }

export function resolveLocalRoot(customRoot: string): string {
  const chosen = customRoot || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (chosen === '~') return os.homedir();
  if (chosen.startsWith('~/') || chosen.startsWith('~\\')) return path.join(os.homedir(), chosen.slice(2));
  return path.resolve(chosen);
}

async function findRollouts(dir: string, remaining: { count: number }, level = 0): Promise<string[]> {
  if (level > 5 || remaining.count <= 0) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  // Codex uses sessions/YYYY/MM/DD; newest date directories first when bounded.
  entries.sort((a, b) => b.name.localeCompare(a.name));
  const found: string[] = [];
  for (const entry of entries) {
    if (remaining.count <= 0) break;
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findRollouts(current, remaining, level + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(current);
      remaining.count--;
    }
  }
  return found;
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

async function readExtendedTail(file: string, size: number): Promise<{ text: string; clipped: boolean }> {
  const length = Math.min(size, EXTENDED_TAIL_BYTES);
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

async function mapLimited<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await map(items[index]!);
    }
  }));
  return result;
}

export async function scanLocal(root: string, sourceId = 'local', sourceLabel = 'Windows', now = Date.now()): Promise<SessionRecord[]> {
  const sessionsDir = path.join(root, 'sessions');
  const files = await findRollouts(sessionsDir, { count: MAX_DISCOVERED });
  const stats = await mapLimited(files, 24, async (file) => {
    try { const stat = await fs.stat(file); return { file, mtime: stat.mtimeMs, size: stat.size }; }
    catch { return null; }
  });
  const newest = stats.filter((s): s is NonNullable<typeof s> => !!s)
    .sort((a, b) => b.mtime - a.mtime).slice(0, MAX_RETURNED);
  const sessions = await mapLimited(newest, 12, async ({ file, mtime, size }): Promise<SessionRecord | null> => {
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
      if (state.status === 'unknown' && clipped && now - mtime <= RECENT_MS) {
        const extended = await readExtendedTail(file, size);
        state = inferStatus(extended.text, mtime, now, extended.clipped);
        inputTail = extended.text;
        inputTailClipped = extended.clipped;
      }
      const lastInputAt = extractLastUserInputAt(inputTail, inputTailClipped);
      const lastUserInputAgeAtSourceMs = lastInputAt == null ? null : now - lastInputAt;
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
    if (!s || seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
  cache.retain(new Set(newest.map(item => item.file)));
  await enrichLocalTitles(root, unique);
  return unique;
}
