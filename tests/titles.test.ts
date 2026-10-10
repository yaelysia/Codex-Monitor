import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractFirstUserTitle } from '../electron/rollout';
import { enrichLocalTitles, namesFromIndex, normalizeTitle } from '../electron/titles';
import type { SessionRecord } from '../src/shared/types';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});
function session(id: string, title: string | null = null): SessionRecord {
  return { id, key: `local:${id}`, sourceId: 'local', sourceLabel: 'Windows', workspace: 'C:\\app',
    title, status: 'unknown', statusReason: '', updatedAt: Date.now(), startedAt: null };
}

describe('Codex session title resolution', () => {
  it('uses newest nonempty session index name even with broken JSONL entries', () => {
    const id = 'a'.repeat(36);
    const text = [
      JSON.stringify({ id, thread_name: '旧标题' }),
      '{invalid json',
      JSON.stringify({ id, thread_name: '新标题' }),
      JSON.stringify({ id, thread_name: ' ' }),
    ].join('\n');
    expect(namesFromIndex(text, new Set([id])).get(id)).toBe('新标题');
    expect(namesFromIndex('partial\n' + text, new Set([id]), true).get(id)).toBe('新标题');
  });

  it('reads the initial user message without exposing whole transcript data', () => {
    const lines = [
      { type: 'session_meta', payload: { cwd: '/app' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '修复登录页\n并补测试' } },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(extractFirstUserTitle(lines)).toBe('修复登录页 并补测试');
    expect(normalizeTitle('')).toBeNull();
  });

  it('prefers SQLite explicit name, then index, then derived SQLite title', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-title-test-'));
    created.push(root);
    const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, preview TEXT)');
    const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)');
    insert.run('1', '数据库显式命名', '原始标题', '首条内容', '预览');
    insert.run('2', null, '数据库标题', '首条内容', '预览');
    insert.run('3', null, '数据库标题', '首条内容', '预览');
    db.close();
    await fs.writeFile(path.join(root, 'session_index.jsonl'), [
      JSON.stringify({ id: '1', thread_name: '旧索引名' }),
      JSON.stringify({ id: '2', thread_name: '手动命名' }),
    ].join('\n'));
    const sessions = [session('1'), session('2'), session('3'), session('4', '日志首条问题')];
    await enrichLocalTitles(root, sessions);
    expect(sessions.map(row => row.title)).toEqual([
      '数据库显式命名', '手动命名', '数据库标题', '日志首条问题',
    ]);
  });
});
