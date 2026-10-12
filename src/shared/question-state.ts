/** Durable evidence of user questions in Codex rollouts.
 *
 * The live app-server request is not generally persisted, but the originating
 * request_user_input function call (and its function_call_output when answered)
 * are. Paginated async questions also persist an AgentMessage with delivery:"async"
 * and a questions array. This parser only reports unmatched question IDs.
 */
export interface PendingQuestion {
  token: string | null;
  text: string | null;
  blocking: boolean;
}
type ObjectValue = Record<string, unknown>;
const obj = (item: unknown): ObjectValue | null =>
  item !== null && typeof item === 'object' && !Array.isArray(item) ? item as ObjectValue : null;
const str = (s: unknown): string | null => typeof s === 'string' && s.trim() ? s : null;
const safeText = (value: unknown): string | null => {
  const text = str(value)?.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return Array.from(text).slice(0, 160).join('');
};
const validId = (v: unknown): string | null => {
  const text = str(v);
  return text && text.length <= 256 ? text : null;
};
const toolName = (v: unknown): string | null => {
  const value = str(v);
  return value ? value.split('.').pop()! : null;
};
function questionFromArguments(value: unknown): string | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    if (value.length > 16384) return null;
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const questions = obj(parsed)?.questions;
  if (!Array.isArray(questions)) return null;
  const first = obj(questions[0]);
  return safeText(first?.title) ?? safeText(first?.question) ?? safeText(first?.header);
}
const tokenFor = (kind: string, id: string) => kind + ':' + id;

/** Accepts bounded JSONL content. "clippedStart" drops its potentially partial first row. */
export function detectPendingQuestion(tail: string, clippedStart = false): PendingQuestion {
  const pending = new Map<string, { text: string | null; blocking: boolean }>();
  const lines = tail.split(/\r?\n/);
  if (clippedStart) lines.shift();
  for (const line of lines) {
    let row: ObjectValue | null = null;
    try { row = obj(JSON.parse(line)); } catch { /* partial records */ }
    if (!row) continue;
    const payload = obj(row.payload);
    if (!payload) continue;
    if (row.type === 'response_item') {
      const kind = payload.type;
      if (kind === 'function_call' || kind === 'custom_tool_call') {
        const name = toolName(payload.name);
        const call = validId(payload.call_id);
        if (!call) continue;
        if (name === 'request_user_input' || name === 'request_permissions') {
          pending.set(tokenFor('blocking', call), {
            text: questionFromArguments(payload.arguments) ??
              (name === 'request_permissions' ? 'Codex 请求权限确认' : null),
            blocking: true,
          });
        }
      } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
        const call = validId(payload.call_id);
        if (call) pending.delete(tokenFor('blocking', call));
      } else if (kind === 'message' && payload.role === 'user') {
        for (const [key, item] of pending) if (!item.blocking) pending.delete(key);
      }
      continue;
    }
    if (row.type !== 'event_msg') continue;
    const kind = payload.type;
    if (kind === 'user_message') {
      for (const [key, item] of pending) if (!item.blocking) pending.delete(key);
    } else if (kind === 'item_completed') {
      const item = obj(payload.item);
      if ((item?.type === 'AgentMessage' || item?.type === 'agentMessage') &&
          item.delivery === 'async' && Array.isArray(item.questions) && item.questions.length) {
        const id = validId(item.id);
        if (id) pending.set(tokenFor('async', id), {
          text: questionFromArguments({ questions: item.questions }), blocking: false,
        });
      }
    } else if (kind === 'turn_complete' || kind === 'task_complete' ||
      kind === 'turn_aborted' || kind === 'turn_started' || kind === 'task_started') {
      // A completed/interrupted or new turn cannot still be blocked on the old
      // synchronous tool. Async questions explicitly remain until a user reply.
      for (const [key, item] of pending) if (item.blocking) pending.delete(key);
    }
    // Bound malformed/history-heavy tails without any large retained payloads.
    if (pending.size > 128) pending.delete(pending.keys().next().value!);
  }
  const latest = [...pending.entries()].at(-1);
  return latest ? {
    token: latest[0],
    text: latest[1].text,
    blocking: latest[1].blocking,
  } : { token: null, text: null, blocking: false };
}
