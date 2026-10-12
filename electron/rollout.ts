import path from 'node:path';
import type { SessionStatus } from '../src/shared/types';
import { normalizeTitle } from './titles';
import { detectPendingQuestionRows } from '../src/shared/question-state';

const ACTIVE_WINDOW_MS = 90_000;
const WAIT_WINDOW_MS = 10 * 60_000;
const QUESTION_AGE_LIMIT_MS = 6 * 60 * 60_000;
const START_EVENTS = new Set(['task_started', 'turn_started']);
const END_EVENTS = new Set(['task_complete', 'turn_complete']);
const ABORT_EVENTS = new Set(['turn_aborted']);
const WAIT_EVENTS = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'request_user_input',
  'request_permissions',
  'elicitation_request',
]);
const RESUME_EVENTS = new Set(['exec_command_begin', 'patch_apply_begin', 'agent_message', 'agent_reasoning']);
const COMPACT_RESPONSE_ITEMS = new Set(['compaction', 'context_compaction', 'contextCompaction']);
const COMPACT_TURN_ITEMS = new Set(['ContextCompaction', 'contextCompaction', 'context_compaction']);

/** Checkpoints are persisted after compaction, unlike transient item-start events. */
function isCompactionCheckpoint(row: JsonObject, payload: JsonObject | null): boolean {
  if (row.type === 'compacted') return true;
  if (row.type === 'response_item' && typeof payload?.type === 'string') {
    return COMPACT_RESPONSE_ITEMS.has(payload.type);
  }
  if (row.type === 'event_msg') {
    if (payload?.type === 'context_compacted') return true;
    if (payload?.type === 'item_completed') {
      const kind = object(payload.item)?.type;
      return typeof kind === 'string' && COMPACT_TURN_ITEMS.has(kind);
    }
  }
  return false;
}

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

/** Parse a timestamp only; never expose a user message's text. */
export function extractLastUserInputAt(tail: string, clippedStart = false): number | null {
  let last: number | null = null;
  for (const row of jsonlRows(tail, clippedStart)) {
    const payload = object(row.payload);
    if (row.type !== 'event_msg' || payload?.type !== 'user_message' ||
        typeof row.timestamp !== 'string') continue;
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at) && at > 0 && (last === null || at > last)) last = at;
  }
  return last;
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

/** First user prompt is a fallback if Codex's SQLite/name index has no title. */
export function extractFirstUserTitle(head: string): string | null {
  let responseItemTitle: string | null = null;
  for (const row of jsonlRows(head, false)) {
    const payload = object(row.payload);
    if (row.type === 'event_msg' && payload?.type === 'user_message') {
      const title = normalizeTitle(payload.message);
      if (title) return title;
    }
    if (row.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
      const content = payload.content;
      if (typeof content === 'string') responseItemTitle ??= normalizeTitle(content);
      if (Array.isArray(content)) {
        const text = content.filter(item => object(item)?.type === 'input_text')
          .map(item => object(item)?.text).filter((item): item is string => typeof item === 'string').join(' ');
        responseItemTitle ??= normalizeTitle(text);
      }
    }
  }
  return responseItemTitle;
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
  finishedToken: string | null;
  waitingToken: string | null;
  pendingQuestionToken: string | null;
  questionText: string | null;
} {
  let phase: 'started' | 'finished' | 'interrupted' | 'failed' | 'unknown' = 'unknown';
  let awaiting = false;
  let finishedToken: string | null = null;
  let waitingToken: string | null = null;
  let checkpointAfterBoundary = false;
  const parsedRows = jsonlRows(tail, clippedStart);
  const question = detectPendingQuestionRows(parsedRows);
  for (const row of parsedRows) {
    const payload = object(row.payload);
    if (isCompactionCheckpoint(row, payload)) {
      checkpointAfterBoundary = true;
      continue;
    }
    if (row.type !== 'event_msg') continue;
    const event = payload?.type;
    if (typeof event !== 'string') continue;
    // Persisted event timestamp + turn id survives unrelated later file writes.
    // When both are missing, the tracker falls back to lifecycle transitions only.
    const marker = [typeof row.timestamp === 'string' ? row.timestamp : '',
      typeof payload?.turn_id === 'string' ? payload.turn_id : ''].join('|');
    const token = marker === '|' ? null : marker;
    if (START_EVENTS.has(event)) {
      phase = 'started'; awaiting = false; waitingToken = null;
      finishedToken = null; checkpointAfterBoundary = false;
    } else if (END_EVENTS.has(event)) {
      phase = payload?.error == null ? 'finished' : 'failed';
      awaiting = false; finishedToken = phase === 'finished' ? token : null;
      waitingToken = null; checkpointAfterBoundary = false;
    } else if (ABORT_EVENTS.has(event)) {
      phase = 'interrupted'; awaiting = false; finishedToken = null;
      waitingToken = null; checkpointAfterBoundary = false;
    }
    else if (WAIT_EVENTS.has(event) && phase === 'started') { awaiting = true; waitingToken = token; }
    else if (RESUME_EVENTS.has(event) && phase === 'started') { awaiting = false; waitingToken = null; }
  }
  const age = Math.max(0, now - updatedAt);
  const terminal = phase === 'finished' && !checkpointAfterBoundary;
  // A durable, unmatched request_user_input function call is stronger evidence
  // than the absence of transient request/approval event_msg records. Async
  // questions are notifications, not proof a turn stopped executing.
  const questionFresh = age <= QUESTION_AGE_LIMIT_MS;
  const pendingQuestionToken = questionFresh ? question.token : null;
  const tokenFields = {
    finishedToken: terminal && !question.blocking ? finishedToken : null,
    waitingToken: question.blocking && pendingQuestionToken ? pendingQuestionToken :
      awaiting ? waitingToken : null,
    pendingQuestionToken,
    questionText: pendingQuestionToken ? question.text : null,
  };
  if (question.blocking && pendingQuestionToken) {
    return { ...tokenFields, status: 'waiting',
      statusReason: '检测到未匹配回答的 Codex 请求用户输入/确认工具调用；可能正在等待用户处理' };
  }
  if (terminal) {
    return { ...tokenFields, status: 'finished', statusReason: '检测到本轮正常结束事件；不代表客户端已退出' };
  }
  if (phase === 'interrupted' && !checkpointAfterBoundary) {
    return { ...tokenFields, status: 'interrupted', statusReason: '检测到 Codex 本轮中断事件，不能视为任务完成' };
  }
  if (phase === 'failed' && !checkpointAfterBoundary) {
    return { ...tokenFields, status: 'failed', statusReason: '检测到本轮结束事件携带错误信息，不能视为正常完成' };
  }
  if (phase === 'started' && awaiting && age <= WAIT_WINDOW_MS) {
    return { ...tokenFields, status: 'waiting', statusReason: '日志存在等待用户操作事件（推断）' };
  }
  if (phase === 'started' && age <= ACTIVE_WINDOW_MS) {
    return {
      ...tokenFields, status: 'working',
      statusReason: checkpointAfterBoundary
        ? '检测到上下文压缩结果，尚无本轮结束事件；可能仍在继续执行（推断）'
        : '本轮已开始、尚无结束事件，且最近 90 秒有日志更新（推断）',
    };
  }
  // The start event may be outside the bounded file tail. A *completed*
  // compaction checkpoint is fresh progress evidence, not proof it is currently compacting.
  if (checkpointAfterBoundary && age <= ACTIVE_WINDOW_MS) {
    return { ...tokenFields, status: 'working',
      statusReason: '最近检测到上下文压缩完成记录，但未见之后的任务结束事件；可能正在继续执行（推断）' };
  }
  if (phase === 'started') {
    return { ...tokenFields, status: 'unknown',
      statusReason: '执行开始后未见结束事件，但日志已停止更新；无法确认是否仍在运行' };
  }
  return { ...tokenFields, status: 'unknown', statusReason: '没有足够的近期执行生命周期记录' };
}
