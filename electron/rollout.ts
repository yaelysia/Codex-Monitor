import path from 'node:path';
import type { SessionStatus } from '../src/shared/types';

const ACTIVE_WINDOW_MS = 90_000;
const WAIT_WINDOW_MS = 10 * 60_000;
const START_EVENTS = new Set(['task_started', 'turn_started']);
const END_EVENTS = new Set(['task_complete', 'turn_complete', 'turn_aborted']);
const WAIT_EVENTS = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'request_user_input',
  'request_permissions',
  'elicitation_request',
]);
const RESUME_EVENTS = new Set(['exec_command_begin', 'patch_apply_begin', 'agent_message', 'agent_reasoning']);

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function parseLine(line: string): JsonObject | null {
  try { return object(JSON.parse(line)); } catch { return null; }
}

/** Read only complete JSONL rows; the first/last row may be cut by a bounded file read. */
export function jsonlRows(text: string, clippedStart: boolean): JsonObject[] {
  const lines = text.split(/\r?\n/);
  if (clippedStart) lines.shift();
  return lines.map(parseLine).filter((row): row is JsonObject => !!row);
}

function safeCwd(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length ? value : null;
}

/** The initial session_meta can exceed the header read budget (base_instructions). */
export function extractWorkspace(head: string, tail: string): string | null {
  let workspace: string | null = null;
  for (const row of jsonlRows(head, false)) {
    if (row.type !== 'session_meta') continue;
    workspace = safeCwd(object(row.payload)?.cwd) ?? workspace;
    if (workspace) break;
  }
  if (!workspace) {
    const match = /"cwd"\s*:\s*("(?:\\.|[^"\\])*")/.exec(head);
    if (match) {
      try { workspace = safeCwd(JSON.parse(match[1]!)); } catch { /* truncated */ }
    }
  }
  // turn_context may change cwd during a resumed session; latest one wins.
  for (const row of jsonlRows(tail, false)) {
    if (row.type === 'turn_context') workspace = safeCwd(object(row.payload)?.cwd) ?? workspace;
  }
  return workspace;
}

export function extractSessionId(head: string, filename: string): string {
  for (const row of jsonlRows(head, false)) {
    if (row.type !== 'session_meta') continue;
    const id = object(row.payload)?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const idMatch = /"id"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(head);
  if (idMatch) return idMatch[1]!;
  return /([0-9a-fA-F]{8}-[0-9a-fA-F-]{27,})/.exec(filename)?.[1] ?? path.basename(filename, '.jsonl');
}

export function inferStatus(tail: string, updatedAt: number, now = Date.now(), clippedStart = false): {
  status: SessionStatus;
  statusReason: string;
} {
  let phase: 'started' | 'finished' | 'unknown' = 'unknown';
  let awaiting = false;
  for (const row of jsonlRows(tail, clippedStart)) {
    if (row.type !== 'event_msg') continue;
    const event = object(row.payload)?.type;
    if (typeof event !== 'string') continue;
    if (START_EVENTS.has(event)) { phase = 'started'; awaiting = false; }
    else if (END_EVENTS.has(event)) { phase = 'finished'; awaiting = false; }
    else if (WAIT_EVENTS.has(event) && phase === 'started') awaiting = true;
    else if (RESUME_EVENTS.has(event) && phase === 'started') awaiting = false;
  }
  const age = Math.max(0, now - updatedAt);
  if (phase === 'finished') return { status: 'finished', statusReason: '检测到本轮结束事件；不代表客户端已退出' };
  if (phase === 'started' && awaiting && age <= WAIT_WINDOW_MS) {
    return { status: 'waiting', statusReason: '日志存在等待用户操作事件（推断）' };
  }
  if (phase === 'started' && age <= ACTIVE_WINDOW_MS) {
    return { status: 'working', statusReason: '本轮已开始、尚无结束事件，且最近 90 秒有日志更新（推断）' };
  }
  if (phase === 'started') return { status: 'unknown', statusReason: '执行开始后未见结束事件，但日志已停止更新；无法确认是否仍在运行' };
  return { status: 'unknown', statusReason: '没有足够的执行生命周期记录' };
}
