import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyLogSignals, inspectDesktopLogs, parseOptions } from '../scripts/probe-desktop-logs.mjs';

const threadId = '019a1020-0000-7000-8000-111122223333';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-diagnostics-'));

describe('scoped read-only Desktop runtime log probe', () => {
  it('accepts only a supplied thread UUID and strictly bounded sampling', () => {
    expect(parseOptions(['--thread-id', threadId, '--duration', '0']).threadId).toBe(threadId);
    expect(() => parseOptions([])).toThrow(/thread-id/);
    expect(() => parseOptions(['--thread-id', 'invalid'])).toThrow(/UUID/);
    expect(() => parseOptions(['--thread-id', threadId, '--limit', '9000'])).toThrow(/range/);
    expect(() => parseOptions(['--thread-id', threadId, '--home', '../private'])).toThrow(/absolute/);
  });

  it('does not materialize a missing log DB or expose a private path', async () => {
    const home = temp();
    try {
      const result = await inspectDesktopLogs({ home, threadId, duration: 0, limit: 50, pollMs: 500 });
      expect(result).toMatchObject({ available: false, code: 'no_existing_log_store' });
      expect(fs.readdirSync(home)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(home);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('reports only event type counts from the selected thread, never raw log text', async () => {
    const home = temp();
    const db = new DatabaseSync(path.join(home, 'logs_2.sqlite'));
    try {
      db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, thread_id TEXT, feedback_log_body TEXT)');
      const insert = db.prepare('INSERT INTO logs (ts, thread_id, feedback_log_body) VALUES (?, ?, ?)');
      insert.run(1600000000, threadId, 'turn/started private-prompt-should-never-leak');
      insert.run(1600000001, threadId, 'thread/status/changed waitingOnUserInput PRIVATE-PATH');
      insert.run(1600000002, 'other-thread', 'turn/completed DIFFERENT-ACCOUNT-SECRET');
      const result = await inspectDesktopLogs({ home, threadId, duration: 0, limit: 50, pollMs: 500 });
      expect(result).toMatchObject({
        available: true, rowsScanned: 2, authoritativeRuntimeStatus: false,
        signals: { turn_started: 1, thread_status_change: 1, waiting_user_flag: 1 },
      });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|prompt|PATH|DIFFERENT-ACCOUNT-SECRET/);
    } finally { db.close(); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('never assumes a log-marker match proves a live runtime state', () => {
    expect(classifyLogSignals('turn/completed text from a historic record')).toEqual(['turn_completed']);
    expect(classifyLogSignals('none')).toEqual([]);
  });
});
