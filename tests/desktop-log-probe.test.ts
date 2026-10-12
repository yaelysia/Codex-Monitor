import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/probe-desktop-logs.mjs');
const threadId = '019a1020-0000-7000-8000-111122223333';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-diagnostics-'));
const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8', timeout: 6000, maxBuffer: 1024 * 1024,
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});

describe('scoped read-only Desktop runtime log CLI', () => {
  it('rejects unscoped/unsafe CLI requests without exposing raw data', () => {
    for (const args of [
      [], ['--thread-id', 'invalid'],
      ['--thread-id', threadId, '--limit', '9000'],
      ['--thread-id', threadId, '--home', '../private'],
    ]) {
      const output = run(...args);
      expect(output.status, output.stderr).toBe(1);
      expect(output.stdout).not.toMatch(/secret|prompt|thread_content/i);
    }
    const help = run('--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('--thread-id UUID');
  });

  it('never creates a missing log store or reveals its local path', () => {
    const home = temp();
    try {
      const output = run('--thread-id', threadId, '--home', home, '--duration', '0');
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({
        available: false, code: 'no_existing_log_store', rowsScanned: 0,
      });
      expect(fs.readdirSync(home)).toEqual([]);
      expect(output.stdout).not.toContain(home);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('counts only target-thread signals and never prints private log bodies', () => {
    const home = temp();
    const db = new DatabaseSync(path.join(home, 'logs_2.sqlite'));
    try {
      db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, thread_id TEXT, feedback_log_body TEXT)');
      const add = db.prepare('INSERT INTO logs (ts, thread_id, feedback_log_body) VALUES (?, ?, ?)');
      add.run(1600000000, threadId, 'turn/started PRIVATE-PROMPT-SHOULD-NEVER-LEAK');
      add.run(1600000001, threadId, 'thread/status/changed waitingOnUserInput PRIVATE-PATH');
      add.run(1600000002, 'other-thread', 'turn/completed DIFFERENT-ACCOUNT-SECRET');
      const output = run('--thread-id', threadId, '--home', home, '--duration', '0', '--limit', '50');
      expect(output.status, output.stderr).toBe(0);
      const data = JSON.parse(output.stdout);
      expect(data).toMatchObject({
        available: true, rowsScanned: 2, authoritativeRuntimeStatus: false,
        signals: { turn_started: 1, thread_status_change: 1, waiting_user_flag: 1 },
      });
      expect(data.signals.turn_start_request).toBeUndefined();
      expect(output.stdout).not.toMatch(/PRIVATE|PROMPT|PATH|DIFFERENT-ACCOUNT-SECRET/);
    } finally {
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not accept alternate database schemas as authoritative state', () => {
    const home = temp();
    const db = new DatabaseSync(path.join(home, 'logs_2.sqlite'));
    try {
      db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, message TEXT)');
      const output = run('--thread-id', threadId, '--home', home);
      expect(output.status, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout)).toMatchObject({
        available: false, code: 'unsupported_log_schema',
      });
    } finally {
      db.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
