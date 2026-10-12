import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanLocal } from '../electron/local';

const created: string[] = [];
afterEach(async () => { await Promise.all(created.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe('local scanner', () => {
  it('reads bounded metadata from dated Codex rollout directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-test-'));
    created.push(root);
    const directory = path.join(root, 'sessions', '2026', '10', '10');
    await fs.mkdir(directory, { recursive: true });
    const id = '01234567-89ab-4cde-8123-123456789abc';
    await fs.writeFile(path.join(directory, `rollout-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/dev/app' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n'));
    const rows = await scanLocal(root, 'local', 'Windows');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, workspace: '/dev/app', status: 'finished', sourceLabel: 'Windows',
      rolloutPath: `2026/10/10/rollout-${id}.jsonl` });
  });
  it('rejects a missing sessions directory explicitly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-test-'));
    created.push(root);
    await expect(scanLocal(root)).rejects.toThrow();
  });
  it('recovers lifecycle events for a fresh rollout longer than the short tail', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-long-'));
    created.push(root);
    const directory = path.join(root, 'sessions', '2026', '10', '10');
    await fs.mkdir(directory, { recursive: true });
    const id = '01234567-89ab-4cde-8123-123456789abc';
    const file = path.join(directory, `rollout-${id}.jsonl`);
    const rows = [
      { type: 'session_meta', payload: { id, cwd: '/tmp/active' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'reasoning', text: 'x'.repeat(250_000) } },
    ];
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const records = await scanLocal(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'working', byteSize: (await fs.stat(file)).size });
    await fs.utimes(file, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    expect((await scanLocal(root))[0]?.status).toBe('unknown');
  });
});
