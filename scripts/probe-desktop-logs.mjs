#!/usr/bin/env node
/** Read-only, scoped diagnostic of existing Codex SQLite runtime logs.
 * Not a live App Server subscription. Never prints log bodies or prompts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const UUID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
const CANDIDATES = Object.freeze([
  ['waiting_user_flag', /\bwaitingOnUserInput\b/i],
  ['waiting_approval_flag', /\bwaitingOnApproval\b/i],
  ['user_input_request', /item\/tool\/requestUserInput/i],
  ['command_approval_request', /item\/commandExecution\/requestApproval/i],
  ['file_approval_request', /item\/fileChange\/requestApproval/i],
  ['permission_request', /item\/permissions\/requestApproval/i],
  ['thread_status_change', /thread\/status\/changed/i],
  ['turn_started', /turn\/started/i],
  ['turn_completed', /turn\/completed/i],
  ['turn_start_request', /turn\/start/i],
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseOptions(args) {
  const result = { threadId: '', home: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    duration: 0, limit: 300, pollMs: 2000 };
  const options = { '--thread-id': 'threadId', '--home': 'home', '--duration': 'duration',
    '--limit': 'limit', '--poll-ms': 'pollMs' };
  for (let i = 0; i < args.length; i++) {
    const [flag] = args[i].split('=', 1);
    if (flag === '--help' || flag === '-h') { result.help = true; continue; }
    const key = options[flag];
    if (!key) throw new Error('Unknown argument: ' + flag.slice(0, 60));
    const value = args[i].includes('=') ? args[i].slice(flag.length + 1) : args[++i];
    if (!value) throw new Error('Missing value for ' + flag);
    result[key] = value;
  }
  if (result.help) return result;
  if (typeof result.threadId !== 'string' || !UUID.test(result.threadId)) {
    throw new Error('--thread-id must be a valid UUID');
  }
  if (typeof result.home !== 'string' || !path.isAbsolute(result.home)) {
    throw new Error('--home must be an absolute CODEX_HOME path');
  }
  for (const [key, min, max] of [['duration', 0, 60], ['limit', 1, 500], ['pollMs', 500, 10000]]) {
    const value = Number(result[key]);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error('--' + key + ' is outside the allowed range');
    result[key] = value;
  }
  return result;
}

export function classifyLogSignals(body) {
  if (typeof body !== 'string') return [];
  return CANDIDATES.filter(([, regex]) => regex.test(body)).map(([name]) => name);
}

function openExistingDb(home) {
  const file = path.join(home, 'logs_2.sqlite');
  if (!fs.existsSync(file)) return { db: null, code: 'no_existing_log_store' };
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA query_only=ON');
    const columns = new Set(db.prepare('PRAGMA table_info(logs)').all().map(row => row.name));
    if (!['id', 'ts', 'thread_id', 'feedback_log_body'].every(name => columns.has(name))) {
      db.close();
      return { db: null, code: 'unsupported_log_schema' };
    }
    return { db, code: null };
  } catch {
    // SQLite can be locked, inaccessible or corrupt. Do not alter/rebuild it.
    return { db: null, code: 'log_store_unreadable' };
  }
}

export async function inspectDesktopLogs(options) {
  const { db, code } = openExistingDb(options.home);
  if (!db) return { available: false, code, rowsScanned: 0, signals: {} };
  const totals = Object.create(null);
  let rowsScanned = 0;
  let latestSignalAt = null;
  let cursor = 0;
  try {
    const initial = db.prepare('SELECT id, ts, substr(feedback_log_body, 1, 512) AS excerpt ' +
      'FROM logs WHERE thread_id = ? ORDER BY id DESC LIMIT ?');
    const increment = db.prepare('SELECT id, ts, substr(feedback_log_body, 1, 512) AS excerpt ' +
      'FROM logs WHERE thread_id = ? AND id > ? ORDER BY id ASC LIMIT ?');
    const record = rows => {
      for (const row of rows) {
        rowsScanned++;
        cursor = Math.max(cursor, row.id);
        const signals = classifyLogSignals(row.excerpt);
        for (const signal of signals) {
          totals[signal] = (totals[signal] || 0) + 1;
          if (Number.isInteger(row.ts) && row.ts > 0)
            latestSignalAt = Math.max(latestSignalAt || 0, row.ts);
        }
      }
    };
    record(initial.all(options.threadId, options.limit).reverse());
    const deadline = Date.now() + options.duration * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(options.pollMs, deadline - Date.now()));
      record(increment.all(options.threadId, cursor, options.limit));
    }
    return {
      available: true, rowsScanned, signals: totals, latestSignalAt,
      // Labels may occur in arbitrary logs; they are clues, not native state.
      authoritativeRuntimeStatus: false,
      note: 'Candidate log markers only; absence/presence is not proof of Desktop state',
    };
  } catch {
    return { available: false, code: 'log_query_failed', rowsScanned, signals: {} };
  } finally { db.close(); }
}

async function main(args) {
  const options = parseOptions(args);
  if (options.help) {
    console.log('npm run probe:desktop-logs -- --thread-id UUID [--duration 15] [--limit 300]');
    return;
  }
  console.log(JSON.stringify(await inspectDesktopLogs(options)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('Desktop log probe failed; no raw diagnostics will be printed');
    process.exitCode = 1;
  });
}
