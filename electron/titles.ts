import fs from 'node:fs/promises';
import path from 'node:path';
import type { SessionRecord } from '../src/shared/types';
import { classifyClientKind } from '../src/shared/session-origin';

const INDEX_TAIL_BYTES = 2 * 1024 * 1024;

/** One readable line, never the full transcript or an AI-generated title. */
export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length > 180 ? chars.slice(0, 180).join('') + '…' : text;
}

export function namesFromIndex(text: string, ids: Set<string>, clipped = false): Map<string, string> {
  const lines = text.split(/\r?\n/);
  if (clipped) lines.shift(); // incomplete initial JSONL record
  const names = new Map<string, string>();
  for (let i = lines.length - 1; i >= 0 && names.size < ids.size; i--) {
    try {
      const row = JSON.parse(lines[i] || 'null') as { id?: unknown; thread_name?: unknown };
      if (typeof row?.id !== 'string' || !ids.has(row.id) || names.has(row.id)) continue;
      const name = normalizeTitle(row.thread_name);
      if (name) names.set(row.id, name);
    } catch { /* a partially written or malformed entry cannot hide valid ones */ }
  }
  return names;
}

type DbTitle = { name?: unknown; title?: unknown; first_user_message?: unknown; preview?: unknown; originator?: unknown };

async function readIndex(root: string, ids: Set<string>): Promise<Map<string, string>> {
  const file = path.join(root, 'session_index.jsonl');
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(INDEX_TAIL_BYTES, stat.size);
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, stat.size - length);
    return namesFromIndex(bytes.subarray(0, bytesRead).toString('utf8'), ids, stat.size > length);
  } catch { return new Map(); }
  finally { await handle?.close(); }
}

/** Optional built-in SQLite reader, without adding a native npm dependency.
 * Older Electron/Node builds may omit node:sqlite; that only removes this title source. */
async function readStateDb(root: string, ids: Set<string>): Promise<Map<string, DbTitle>> {
  if (!ids.size) return new Map();
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(path.join(root, 'state_5.sqlite'), { readOnly: true });
    const info = db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>;
    const available = new Set(info.map(item => item.name));
    const fields = ['name', 'title', 'first_user_message', 'preview', 'originator']
      .filter(key => available.has(key));
    if (!available.has('id') || !fields.length) return new Map();
    const values = Array.from(ids);
    const results = new Map<string, DbTitle>();
    // Chunk for older SQLite builds with stricter bind-variable limits.
    for (let start = 0; start < values.length; start += 150) {
      const group = values.slice(start, start + 150);
      const sql = `SELECT id, ${fields.join(', ')} FROM threads WHERE id IN (${group.map(() => '?').join(',')})`;
      for (const row of db.prepare(sql).all(...group) as Array<DbTitle & { id: string }>) {
        if (typeof row.id === 'string') results.set(row.id, row);
      }
    }
    return results;
  } catch { return new Map(); } // SQLite may be unavailable, locked, or from a different Codex version.
  finally { db?.close(); }
}

/** Priority: current SQLite explicit name > legacy rename index > SQLite title > first user text. */
export async function enrichLocalTitles(root: string, sessions: SessionRecord[]): Promise<void> {
  if (!sessions.length) return;
  const ids = new Set(sessions.map(session => session.id));
  const [indexed, stored] = await Promise.all([readIndex(root, ids), readStateDb(root, ids)]);
  for (const session of sessions) {
    const db = stored.get(session.id);
    // Recent Codex versions persist originator in state_5.sqlite; an older
    // rollout's clipped or absent session_meta must not hide a Desktop client.
    if (!session.clientKind || session.clientKind === 'unknown') {
      session.clientKind = classifyClientKind(db?.originator);
    }
    session.title =
      normalizeTitle(db?.name) ??
      indexed.get(session.id) ??
      normalizeTitle(db?.title) ??
      normalizeTitle(db?.first_user_message) ??
      normalizeTitle(db?.preview) ??
      session.title;
  }
}
