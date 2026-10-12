/** Read-only preview of the newest persisted, user-visible assistant message. */
export type ReplyPhase = 'final_answer' | 'commentary' | 'partial_answer' | 'unspecified';
export interface ReplyExcerpt {
  text: string | null;
  phase: ReplyPhase | null;
  timestamp: string | null;
  truncated: boolean;
}

export const EXCERPT_CHARS = 420;
export const SHORT_TAIL_BYTES = 256 * 1024;
export const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const EMPTY: ReplyExcerpt = { text: null, phase: null, timestamp: null, truncated: false };

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

function textParts(value: unknown, accepted: readonly string[]): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!Array.isArray(value)) return null;
  const texts = value.map(item => obj(item)).filter((item): item is Json => !!item)
    .filter(item => typeof item.type === 'string' && accepted.includes(item.type))
    .map(item => item.text).filter((item): item is string => typeof item === 'string' && !!item.trim());
  return texts.length ? texts.join('\n').trim() : null;
}
const phaseOf = (value: unknown): ReplyPhase | null => {
  if (value === 'analysis' || value === 'reasoning') return null;
  return value === 'final_answer' || value === 'commentary' || value === 'partial_answer'
    ? value : 'unspecified';
};

function assistantText(row: Json): { text: string; phase: ReplyPhase } | null {
  const payload = obj(row.payload);
  if (!payload) return null;
  let text: string | null = null;
  let phase: ReplyPhase | null = null;
  if (row.type === 'event_msg' && payload.type === 'agent_message') {
    phase = phaseOf(payload.phase);
    text = typeof payload.message === 'string' ? payload.message : null;
  } else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    phase = phaseOf(payload.phase);
    text = textParts(payload.content, ['output_text', 'text']);
  } else if (row.type === 'event_msg' && payload.type === 'item_completed') {
    const item = obj(payload.item);
    if (item?.type === 'AgentMessage' || item?.type === 'agentMessage') {
      phase = phaseOf(item.phase);
      text = textParts(item.content, ['Text', 'text']);
    }
  } else if (row.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_complete')) {
    phase = 'final_answer';
    text = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : null;
  }
  if (!phase || !text?.trim()) return null;
  return { text: text.trim(), phase };
}

export function validRolloutPath(value: string): boolean {
  if (value.length > 350 || !value || value.includes('\\') || value.includes('\0')) return false;
  const parts = value.split('/');
  if (parts.length !== 4 || !/^\d{4}$/.test(parts[0]!) ||
    !/^\d{2}$/.test(parts[1]!) || !/^\d{2}$/.test(parts[2]!)) return false;
  return /^[A-Za-z0-9_.-]+\.jsonl$/.test(parts[3]!) &&
    !parts.some(part => part === '.' || part === '..');
}

/** The start can be an incomplete JSONL line; the end may be actively written. */
export function latestReplyExcerpt(text: string, clippedStart: boolean, chars = EXCERPT_CHARS): ReplyExcerpt {
  const lines = text.split(/\r?\n/);
  if (clippedStart) lines.shift();
  for (let index = lines.length - 1; index >= 0; index--) {
    let row: Json | null = null;
    try { row = obj(JSON.parse(lines[index]!)); } catch { /* partial or unrelated record */ }
    if (!row) continue;
    const candidate = assistantText(row);
    if (!candidate) continue;
    const all = Array.from(candidate.text);
    const length = Math.max(1, Math.min(1000, chars));
    const truncated = all.length > length;
    return {
      text: (truncated ? '…' : '') + all.slice(-length).join(''),
      phase: candidate.phase,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
      truncated,
    };
  }
  return { ...EMPTY };
}
