import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readDesktopThreadHints, MAX_DESKTOP_THREAD_HINTS,
  MAX_DESKTOP_EXTRA_ROLLOUTS } from '../electron/desktop-thread-index';
import { scanLocal } from '../electron/local';
import { visibleSessions } from '../src/shared/session-visibility';
import { summarizeDashboardSessions } from '../src/shared/monitor-view';

const NOW = 1_800_000_000_000;
const uuid = (n: number) => '019a21b0-aaaa-7ccc-8ddd-' + String(n).padStart(12, '0');
const PARENT = uuid(1), SECOND = uuid(2), PAGINATED = uuid(3), CHILD = uuid(4), ARCHIVED = uuid(5);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
  await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-desktop-parallel-'));
  roots.push(root);
  const day = path.join(root, 'sessions', '2026', '10', '21');
  await fs.mkdir(day, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, originator TEXT, thread_source TEXT, source TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, preview TEXT, archived_at INTEGER, updated_at_ms INTEGER NOT NULL)");
  const add = db.prepare("INSERT INTO threads (id, originator, thread_source, source, rollout_path, cwd, name, title, preview, archived_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const file = (id: string) => path.join(day, 'rollout-' + id + '.jsonl');
  const put = (id: string, originator: string, rollout: string | null,
    source = JSON.stringify({ appServer: 'desktop' }), archived: number | null = null) =>
    add.run(id, originator, 'user', source, rollout, '/test-workspace', 'Task ' + id.slice(-2),
      null, null, archived, NOW - 5000);
  put(PARENT, 'codex_desktop', file(PARENT));
  put(SECOND, 'codex_desktop', file(SECOND));
  put(PAGINATED, 'codex_desktop', file(PAGINATED)); // No rollout on disk yet.
  put(ARCHIVED, 'codex_desktop', file(ARCHIVED), 'cli', NOW - 100000);
  put(uuid(6), 'codex_cli_rs', file(uuid(6)), 'cli'); // Never promoted as Desktop.
  add.run(CHILD, 'codex_desktop', 'subagent',
    JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: PARENT } } }),
    file(CHILD), '/test-workspace', 'Subagent', null, null, null, NOW - 5000);
  db.close();

  for (const id of [PARENT, SECOND]) {
    await fs.writeFile(file(id), [
      { type: 'session_meta', payload: { id, originator: 'codex_desktop', cwd: '/test-workspace' } },
      { type: 'event_msg', timestamp: new Date(NOW - 22_000).toISOString(),
        payload: { type: 'turn_started', turn_id: 'turn-' + id } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    await fs.utimes(file(id), new Date(NOW - 20_000), new Date(NOW - 20_000));
  }
  // Hundreds of newer unrelated Codex/subagent rollouts evict both Desktop
  // sessions from the old 'top 200 by mtime' selection.
  for (let n = 0; n < 225; n++) {
    const target = path.join(day, 'rollout-filler-' + String(n).padStart(3, '0') + '.jsonl');
    await fs.writeFile(target, JSON.stringify({ type: 'session_meta', payload: {
      id: 'filler-' + n, originator: 'codex_cli_rs',
    } }) + '\n');
    await fs.utimes(target, new Date(NOW - 3000 + n), new Date(NOW - 3000 + n));
  }
  return { root, day, file };
}

describe('Codex Desktop multiple user task inventory', () => {
  it('keeps independent Desktop top-level threads even when rollover files are outside the top 200', async () => {
    const { root } = await fixture();
    const hints = await readDesktopThreadHints(root);
    expect(hints.length).toBe(4); // 3 user roots + 1 explicit child; archived excluded.
    expect(hints.find(row => row.id === CHILD)?.isSubagent).toBe(true);
    expect(hints.filter(row => !row.isSubagent).map(row => row.id))
      .toEqual([PAGINATED, SECOND, PARENT].sort().reverse());
    const rows = await scanLocal(root, 'local', 'Windows', NOW);
    const desktop = rows.filter(row => row.clientKind === 'desktop');
    expect(desktop.filter(row => !row.isSubagent).map(row => row.id).sort())
      .toEqual([PARENT, SECOND, PAGINATED].sort());
    expect(rows.find(row => row.id === PARENT)).toMatchObject({ status: 'working',
      clientKind: 'desktop', rolloutPath: expect.stringContaining(PARENT) });
    expect(rows.find(row => row.id === SECOND)).toMatchObject({ status: 'working',
      clientKind: 'desktop', rolloutPath: expect.stringContaining(SECOND) });
    expect(rows.find(row => row.id === PAGINATED)).toMatchObject({ status: 'unknown',
      rolloutPath: null });
    const visible = visibleSessions(rows);
    expect(visible.some(row => row.id === CHILD)).toBe(false);
    expect(summarizeDashboardSessions(visible).working.filter(row =>
      row.clientKind === 'desktop')).toHaveLength(2);
    expect(visible.some(row => row.id === PAGINATED)).toBe(true);
  });

  it('preserves exact UUID deduplication, title enrichment and the active-index hot path', async () => {
    const { root } = await fixture();
    const cold = await scanLocal(root, 'local', 'Windows', NOW);
    expect(new Set(cold.map(row => row.id.toLowerCase())).size).toBe(cold.length);
    const warm = await scanLocal(root, 'local', 'Windows', NOW + 1000, [], true);
    expect(warm.find(row => row.id === PAGINATED)?.title).toContain('Task');
    expect(warm.filter(row => [PARENT, SECOND].includes(row.id))).toHaveLength(2);
    expect(warm.some(row => row.status === 'finished' && row.id === PAGINATED)).toBe(false);
  });

  it('does not follow outside SQLite rollout paths or invent activity', async () => {
    const { root } = await fixture();
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    const escaping = uuid(8);
    db.prepare('INSERT INTO threads (id, originator, rollout_path, updated_at_ms) VALUES (?, ?, ?, ?)')
      .run(escaping, 'codex_desktop', path.join(os.tmpdir(), 'private', 'rollout-' + escaping + '.jsonl'), NOW);
    db.close();
    const hints = await readDesktopThreadHints(root);
    expect(hints.find(row => row.id === escaping)?.relativePath).toBeNull();
    const rows = await scanLocal(root, 'local', 'Windows', NOW);
    expect(rows.find(row => row.id === escaping)).toMatchObject({
      status: 'unknown', rolloutPath: null,
    });
    expect(JSON.stringify(rows.find(row => row.id === escaping))).not.toContain('private');
  });

  it('degrades safely for missing/old SQLite schemas and remains bounded', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-desktop-no-db-')); roots.push(root);
    expect(await readDesktopThreadHints(root)).toEqual([]);
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, updated_at INTEGER)');
    db.close();
    expect(await readDesktopThreadHints(root)).toEqual([]);
    expect(MAX_DESKTOP_THREAD_HINTS).toBeLessThanOrEqual(128);
    expect(MAX_DESKTOP_EXTRA_ROLLOUTS).toBeLessThanOrEqual(32);
  });
});
