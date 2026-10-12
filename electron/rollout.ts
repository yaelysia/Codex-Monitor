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


/** Modern paginated Codex histories persist UserMessage as item_completed.
 * Older rollouts use event_msg.user_message or response_item.message(user).
 * Only record the event kind: never inspect or return prompt contents.
 */
function isPersistedUserInput(row: JsonObject, payload: JsonObject | null): boolean {
  if (!payload) return false;
  if (row.type === 'event_msg') {
    if (payload.type === 'user_message') return true;
    const itemType = object(payload.item)?.type;
    return payload.type === 'item_completed' &&
      (itemType === 'UserMessage' || itemType === 'userMessage');
  }
  return row.type === 'response_item' &&
    payload.type === 'message' && payload.role === 'user';
}

/** Parse a timestamp only; never expose a user message's text. */
export function extractLastUserInputAt(tail: string, clippedStart = false): number | null {
  let last: number | null = null;
  for (const row of jsonlRows(tail, clippedStart)) {
    const payload = object(row.payload);
    if (!isPersistedUserInput(row, payload) || typeof row.timestamp !== 'string') continue;
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
  let phase: 'started' | 'submitted' | 'finished' | 'interrupted' | 'failed' | 'unknown' = 'unknown';
  let activeTurnId: string | null = null;
  let lastTerminalTurnId: string | null = null;
  let awaiting = false;
  let finishedToken: string | null = null;
  let waitingToken: string | null = null;
  let checkpointAfterBoundary = false;
  const parsedRows = jsonlRows(tail, clippedStart);
  const question = detectPendingQuestionRows(parsedRows);
  for (const row of parsedRows) {
    const payload = object(row.payload);
    // A new submitted message invalidates an older turn's completion, even
    // when the corresponding turn/started event has not yet been persisted.
    if (isPersistedUserInput(row, payload) && phase !== 'started') {
      phase = 'submitted';
      activeTurnId = null;
      awaiting = false;
      finishedToken = null;
      waitingToken = null;
      checkpointAfterBoundary = false;
    }
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
    const turnId = typeof payload?.turn_id === 'string' && payload.turn_id
      ? payload.turn_id : null;
    if (START_EVENTS.has(event)) {
      phase = 'started'; activeTurnId = turnId;
      awaiting = false; waitingToken = null;
      finishedToken = null; checkpointAfterBoundary = false;
    } else if (END_EVENTS.has(event) || ABORT_EVENTS.has(event)) {
      // A late turn-a completion must never close currently running turn-b.
      if (activeTurnId && turnId && activeTurnId !== turnId) continue;
      // Ignore duplicate terminal events from a prior turn when a fresh user
      // input is already pending; old histories may lack turn IDs.
      if ((!activeTurnId && turnId && turnId === lastTerminalTurnId) ||
          (phase === 'submitted' && !activeTurnId && !turnId)) continue;
      phase = ABORT_EVENTS.has(event) ? 'interrupted' :
        payload.error == null ? 'finished' : 'failed';
      awaiting = false;
      finishedToken = phase === 'finished' ? token : null;
      waitingToken = null;
      checkpointAfterBoundary = false;
      lastTerminalTurnId = turnId ?? activeTurnId;
      activeTurnId = null;
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
  if (terminal && pendingQuestionToken) {
    // Structured async questions remain outstanding after a turn ends. That
    // does not prove the model is blocked, or that the user's task is done.
    return { ...tokenFields, finishedToken: null, status: 'unknown',
      statusReason: '本轮已结束，但存在尚未回答的异步提问；是否仍有后续执行，需客户端实时状态确认' };
  }
  if (terminal) {
    return { ...tokenFields, status: 'finished',
      statusReason: '检测到本轮回复结束事件；不代表整段会话或用户任务已完成' };
  }
  if (phase === 'interrupted' && !checkpointAfterBoundary) {
    return { ...tokenFields, status: 'interrupted', statusReason: '检测到 Codex 本轮中断事件，不能视为任务完成' };
  }
  if (phase === 'failed' && !checkpointAfterBoundary) {
    return { ...tokenFields, status: 'failed', statusReason: '检测到本轮结束事件携带错误信息，不能视为正常完成' };
  }
  if (phase === 'submitted') {
    return { ...tokenFields, status: age <= ACTIVE_WINDOW_MS ? 'working' : 'unknown',
      statusReason: age <= ACTIVE_WINDOW_MS
        ? '检测到新的用户输入，但该轮开始/结束事件尚不完整；可能执行中（推断）'
        : '检测到新的用户输入，但随后没有可靠轮次事件；不能判定任务已完成' };
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
