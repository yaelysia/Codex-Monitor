import fs from 'node:fs/promises';
import path from 'node:path';
import { classifySessionOrigin } from '../src/shared/session-origin';
import { THREAD_UUID } from '../src/shared/native-state';
import { validPinnedRolloutPath } from '../src/shared/pinned-rollouts';
import { normalizeTitle } from './titles';

/** Database is only a bounded, read-only discovery hint. A row without an
 * observed rollout or native lifecycle is NEVER proof that a turn is active.
 */
export interface DesktopThreadHint {
  id: string;
  title: string | null;
  workspace: string | null;
  relativePath: string | null;
  updatedAt: number;
  isSubagent: boolean;
  parentThreadId: string | null;
}
export const MAX_DESKTOP_THREAD_HINTS = 96;
export const MAX_DESKTOP_EXTRA_ROLLOUTS = 32;
type Row = Record<string, unknown>;
// Exact canonical Codex Desktop originators allow SQLite to use an index when
// available; LOWER()/TRIM() on every row would force a full table scan.
const originators = ['codex_desktop', 'codex_work_desktop', 'Codex Desktop'];
function object(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function source(value: unknown): unknown {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { return JSON.parse(value); }
  catch { return value; }
}
function timestampMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const ms = value < 100_000_000_000 ? value * 1000 : value;
  return Number.isSafeInteger(ms) ? ms : null;
}
function verifiedPath(root: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  const sessions = path.resolve(root, 'sessions');
  const absolute = path.isAbsolute(value) ? path.resolve(value)
    : path.resolve(root, value);
  const relative = path.relative(sessions, absolute).split(path.sep).join('/');
  return validPinnedRolloutPath(relative) ? relative : null;
}

/** Read ONLY explicit Desktop originator metadata, never arbitrary App Server
 * threads and never transcript contents. Column-aware across Codex DB schemas.
 * The DB may be absent, locked, or a different format: original JSONL
 * scanning continues unchanged in every such case.
 */
export async function readDesktopThreadHints(root: string): Promise<DesktopThreadHint[]> {
  let db: import('node:sqlite').DatabaseSync | null = null;
  try {
    const dbFile = path.join(root, 'state_5.sqlite');
    const stat = await fs.lstat(dbFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return [];
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbFile, { readOnly: true });
    const columns = new Set((db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>)
      .map(item => item.name));
    const updated = columns.has('updated_at_ms') ? 'updated_at_ms' :
      columns.has('updated_at') ? 'updated_at' : null;
    if (!columns.has('id') || !columns.has('originator') || !updated) return [];
    const wanted = ['id', updated, 'name', 'title', 'preview', 'cwd', 'rollout_path',
      'source', 'thread_source', 'originator'];
    const fields = wanted.filter((key, index) => columns.has(key) &&
      wanted.indexOf(key) === index);
    const archive = [
      ...(columns.has('archived_at') ? ['archived_at IS NULL'] : []),
      ...(columns.has('archived') ? ['archived = 0'] : []),
    ];
    const sql = 'SELECT ' + fields.join(', ') + ' FROM threads WHERE ' +
      "originator IN (?, ?, ?)" +
      (archive.length ? ' AND ' + archive.join(' AND ') : '') +
      ' ORDER BY ' + updated + ' DESC, id DESC LIMIT ' + MAX_DESKTOP_THREAD_HINTS;
    const seen = new Set<string>(), result: DesktopThreadHint[] = [];
    for (const row of db.prepare(sql).all(...originators) as Row[]) {
      if (typeof row.id !== 'string' || !THREAD_UUID.test(row.id)) continue;
      const id = row.id.toLowerCase();
      if (seen.has(id)) continue;
      const updatedAt = timestampMs(row[updated]);
      if (updatedAt === null) continue;
      const provenance = classifySessionOrigin({
        id, source: source(row.source), thread_source: row.thread_source,
      });
      result.push({ id, updatedAt,
        title: normalizeTitle(row.name) ?? normalizeTitle(row.title) ?? normalizeTitle(row.preview),
        workspace: typeof row.cwd === 'string' && row.cwd.trim() ? row.cwd : null,
        relativePath: verifiedPath(root, row.rollout_path),
        isSubagent: provenance.isSubagent,
        parentThreadId: provenance.parentThreadId,
      });
      seen.add(id);
    }
    return result;
  } catch {
    return []; // Missing/locked/different SQLite cannot break file evidence.
  } finally { db?.close(); }
}
