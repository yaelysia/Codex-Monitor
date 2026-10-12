import type { SessionRecord } from './types';

export type DesktopLogEvent = {
  threadId: string;
  at: number;
  type: 'turn-start-accepted' | 'turn-displayed-complete';
  turnId?: string;
};
export const DESKTOP_LOG_EVENT_MAX_AGE_MS = 24 * 60 * 60_000;
const DESKTOP_ACTIVE_EVIDENCE_MS = 45 * 60_000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const START = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}Z\s+info\s+\[AppServerConnection\]\s+response_routed\b/;
const END = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}Z\s+info\s+\[electron-message-handler\]\s+\[desktop-notifications\]\s+show turn-complete\b/;

/** Read *only* field markers from a known Desktop log grammar. Do not log,
 * retain or return any unrecognized text, and never trust "unknown conversation"
 * renderer errors as parent turn events.
 */
function field(line: string, key: string): string | null {
  const found = new RegExp('(?:^|\\s)' + key + '=([^\\s]+)').exec(line);
  return found?.[1] ?? null;
}

export function parseDesktopLogEvent(line: string, now = Date.now()): DesktopLogEvent | null {
  if (line.length > 10_000 || (!START.test(line) && !END.test(line))) return null;
  const timestamp = /^\S+/.exec(line)?.[0];
  const at = timestamp ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(at) || at <= 0 || at > now + 5000 ||
      now - at > DESKTOP_LOG_EVENT_MAX_AGE_MS) return null;
  const threadId = field(line, 'conversationId');
  if (!threadId || !UUID.test(threadId)) return null;
  if (START.test(line)) {
    // Success from the GUI-owned App Server is stronger than file-size changes,
    // but does not by itself guarantee the model remains busy forever.
    if (field(line, 'method') !== 'turn/start' || field(line, 'errorCode') !== 'null') return null;
    return { threadId: threadId.toLowerCase(), at, type: 'turn-start-accepted' };
  }
  const turnId = field(line, 'turnId');
  if (!turnId || !UUID.test(turnId)) return null;
  return { threadId: threadId.toLowerCase(), at, type: 'turn-displayed-complete',
    turnId: turnId.toLowerCase() };
}

/** Keep only latest *trusted* lifecycle event per conversation, not chat text. */
export function newestDesktopEvents(events: readonly DesktopLogEvent[]): Map<string, DesktopLogEvent> {
  const latest = new Map<string, DesktopLogEvent>();
  for (const event of events) {
    const prior = latest.get(event.threadId);
    if (!prior || event.at > prior.at ||
        (event.at === prior.at && event.type === 'turn-displayed-complete')) {
      latest.set(event.threadId, event);
    }
  }
  return latest;
}

function finishedAt(token: string | null | undefined): number | null {
  if (!token) return null;
  const timestamp = token.split('|', 1)[0];
  const at = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(at) ? at : null;
}

/** Supplement local Desktop metadata with explicit GUI-owned turn/start events.
 * Never override waiting, failing, or aborted turns; a durable completion after
 * start wins. Never announce "definitely running" from this auxiliary source.
 */
export function applyDesktopLogEvidence(
  rows: SessionRecord[], latest: ReadonlyMap<string, DesktopLogEvent>, now = Date.now(),
): void {
  for (const row of rows) {
    if (row.clientKind !== 'desktop' || row.isSubagent) continue;
    const event = latest.get(row.id.toLowerCase());
    if (!event || event.type !== 'turn-start-accepted' ||
        now - event.at < -5000 || now - event.at > DESKTOP_ACTIVE_EVIDENCE_MS) continue;
    if (row.status === 'waiting' || row.status === 'failed' || row.status === 'interrupted' ||
        row.pendingQuestionToken) continue;
    const completionAt = finishedAt(row.finishedToken);
    if (completionAt !== null && completionAt >= event.at - 2000) continue;
    // A previously completed turn with no sortable timestamp cannot be safely
    // replaced by an unrelated accepted-start event.
    if (row.status === 'finished' && completionAt === null) continue;
    if (row.status === 'working') continue; // Preserve existing, stronger evidence.
    row.status = 'working';
    row.finishedToken = null;
    row.statusReason =
      'Codex Desktop 自身日志确认本会话 turn/start 已被接受，尚未观察到匹配的结束信号；可能执行中（非实时订阅）';
  }
}


/** Desktop can produce many megabytes of logs in one long turn. Keep only
 * previously parsed (threadId, lifecycle, time) evidence, so a turn/start
 * is not lost when that original log line rotates out of the bounded tail.
 */
export class DesktopLogEventCache {
  private latest = new Map<string, DesktopLogEvent>();
  observe(events: ReadonlyMap<string, DesktopLogEvent>, now = Date.now()): Map<string, DesktopLogEvent> {
    for (const [threadId, event] of events) {
      const prior = this.latest.get(threadId);
      if (!prior || event.at > prior.at ||
          (event.at === prior.at && event.type === 'turn-displayed-complete')) {
        this.latest.set(threadId, event);
      }
    }
    for (const [threadId, event] of this.latest) {
      if (now - event.at > DESKTOP_LOG_EVENT_MAX_AGE_MS ||
          event.at > now + 5000) this.latest.delete(threadId);
    }
    // Never expose a mutable view of the retained state to callers.
    return new Map(this.latest);
  }
}
