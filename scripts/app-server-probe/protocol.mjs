/** Minimal read-only Codex App Server protocol projection.
 * Drop question text, tool arguments, command output and all other private
 * payloads. A snapshot is not proof that an unrelated process is subscribed.
 */
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
export const READ_METHODS = Object.freeze(new Set(['initialize', 'thread/loaded/list', 'thread/read']));
export const OBSERVED_METHODS = Object.freeze(new Set([
  'thread/status/changed', 'turn/started', 'turn/completed',
  'item/started', 'item/completed', 'thread/compacted', 'serverRequest/resolved',
  'item/tool/requestUserInput', 'item/permissions/requestApproval',
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/permissions/requestApproval', 'mcpServer/elicitation/request',
]));

export function sanitizeThreadId(id, reveal = false) {
  if (typeof id !== 'string' || !id) return 'unknown';
  if (reveal) return id.slice(0, 128);
  return id.length <= 9 ? id.slice(0, 2) + '…' : id.slice(0, 8) + '…' + id.slice(-4);
}

export function summarizeStatus(raw) {
  const obj = record(raw);
  if (!obj || !['notLoaded', 'idle', 'systemError', 'active'].includes(obj.type)) {
    return { state: 'unknown', flags: [] };
  }
  if (obj.type !== 'active') return { state: obj.type, flags: [] };
  const flags = Array.isArray(obj.activeFlags)
    ? [...new Set(obj.activeFlags.filter(flag => flag === 'waitingOnUserInput' || flag === 'waitingOnApproval'))]
    : [];
  return { state: 'active', flags };
}

export function summarizeThread(raw, showIds = false) {
  const thread = record(raw);
  if (!thread || typeof thread.id !== 'string') return null;
  return {
    id: sanitizeThreadId(thread.id, showIds),
    status: summarizeStatus(thread.status),
    isSubagent: typeof thread.parentThreadId === 'string' && thread.parentThreadId.length > 0,
    // Do not print title, workspace, prompts, tool details or rollout paths.
  };
}

/** Extract only the event kind, thread ID and narrow public status.
 * The probe intentionally never logs full JSON-RPC notifications/requests.
 */
export function summarizePush(message, showIds = false) {
  const packet = record(message);
  if (!packet || typeof packet.method !== 'string') return null;
  if (!OBSERVED_METHODS.has(packet.method)) return null;
  const params = record(packet.params) ?? {};
  const threadId = typeof params.threadId === 'string'
    ? sanitizeThreadId(params.threadId, showIds) : null;
  const summary = { method: packet.method, threadId };
  if (packet.method === 'thread/status/changed') {
    summary.status = summarizeStatus(params.status);
  } else if (packet.method === 'turn/completed') {
    const turn = record(params.turn);
    if (turn) summary.turnStatus =
      ['completed', 'interrupted', 'failed', 'inProgress'].includes(turn.status)
        ? turn.status : 'unknown';
  } else if (packet.method === 'item/started' || packet.method === 'item/completed') {
    const item = record(params.item);
    summary.itemType = item?.type === 'contextCompaction' ? 'contextCompaction'
      : 'other';
  } else if (packet.method.includes('requestApproval') ||
    packet.method === 'item/tool/requestUserInput' ||
    packet.method === 'mcpServer/elicitation/request') {
    summary.pendingRequest = true;
    summary.actionTaken = false;
  }
  return summary;
}
