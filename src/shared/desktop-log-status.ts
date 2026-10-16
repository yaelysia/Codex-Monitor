import type { SessionRecord } from './types';
import { SILENCE_GRACE_MS } from './activity-tracker';

export type DesktopLogEvent = {
  threadId: string;
  at: number;
  type: 'turn-start-accepted' | 'turn-displayed-complete';
  turnId?: string;
};
// A turn may keep running for hours without a lifecycle log. Retain the
// start/end ORDERING for up to three days, but an accepted turn/start alone
// cannot be trusted as ongoing execution for that whole period.
export const DESKTOP_LOG_EVENT_MAX_AGE_MS = 72 * 60 * 60_000;
/** A single native start is bounded by the same silence grace as real JSONL
 * activity. Long turns with fresh file evidence keep their own status.
 */
export const DESKTOP_START_STATUS_MAX_AGE_MS = SILENCE_GRACE_MS;
// Only recent starts establish CURRENT Desktop ownership for deep links.
const DESKTOP_ACTIVE_EVIDENCE_MS = 45 * 60_000;
const FILE_FINISH_SAFETY_MS = 2_000;
const MAX_PERSISTED_EVENTS = 200;
// Restore older, still-unmatched starts after a Monitor restart; otherwise a
// running long turn disappears simply because the monitor was restarted.
const MAX_PERSISTED_AGE_MS = DESKTOP_LOG_EVENT_MAX_AGE_MS;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const START = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}Z\s+info\s+\[AppServerConnection\]\s+response_routed\b/;
const END = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{1,9}Z\s+info\s+\[electron-message-handler\]\s+\[desktop-notifications\]\s+(?:received|show) turn-complete\b/;

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
  // Keep the persisted event type for backwards compatibility. "received"
  // is valid terminal evidence even when no OS toast is shown.
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

/** Bound GUI ownership to the same active-evidence window as status projection.
 * Older starts remain in the event cache for ordering, but cannot claim ownership
 * of a newer CLI/VS Code turn that is independently still working.
 */
export function isActiveDesktopStart(
  event: DesktopLogEvent | null | undefined, now = Date.now(),
): event is DesktopLogEvent & { type: 'turn-start-accepted' } {
  return event?.type === 'turn-start-accepted' &&
    now - event.at >= -5000 && now - event.at <= DESKTOP_ACTIVE_EVIDENCE_MS;
}

/** Native turn/start acceptance is not a subscription to running state.
 * For a short bounded grace period it can supplement ambiguous rollout
 * metadata; an older start stays cached only for start/end ordering. Once
 * stale, it must not turn "unknown" back into "working". Never override
 * explicit terminal / waiting evidence or a definitely later user input.
 */
export function applyDesktopLogEvidence(
  rows: SessionRecord[], latest: ReadonlyMap<string, DesktopLogEvent>, now = Date.now(),
  /** When the rollout source was last actually scanned; for SSH/WSL this lets
   * source-relative age be compared with Windows native event timestamps.
   */
  sourceObservedAt = now,
  /** Earliest local clock of the source scan, to conservatively bound a
   * newer input when a slow SSH scan spans multiple seconds.
   */
  sourceCaptureStartedAt = sourceObservedAt,
): void {
  for (const row of rows) {
    // The recorded originator identifies who CREATED the thread, not who is
    // running its current turn. Desktop may resume a CLI/VS Code/unknown-origin
    // thread: a successful GUI-owned turn/start with this exact UUID is direct
    // evidence regardless of the original clientKind.
    if (row.isSubagent) continue;
    const event = latest.get(row.id.toLowerCase());
    if (!event || event.type !== 'turn-start-accepted' ||
        now - event.at < -5000 || now - event.at > DESKTOP_START_STATUS_MAX_AGE_MS) continue;
    if (row.status === 'waiting' || row.status === 'failed' || row.status === 'interrupted' ||
        row.pendingQuestionToken) continue;
    // Another user submission after the observed Desktop start invalidates
    // that turn's liveness. Compare source-relative age with the EARLIEST scan
    // boundary, not a remote host wall clock or the end of a slow SSH scan.
    const inputAge = row.lastUserInputAgeAtSourceMs;
    if (typeof inputAge === 'number' && Number.isFinite(inputAge) && inputAge >= 0 &&
        Number.isFinite(sourceCaptureStartedAt) &&
        sourceCaptureStartedAt - inputAge > event.at + FILE_FINISH_SAFETY_MS) continue;
    const completionAt = finishedAt(row.finishedToken);
    if (completionAt !== null && completionAt >= event.at - 2000) continue;
    // Older (sometimes truncated) rollout JSONL has turn_complete with NO
    // usable event timestamp. Only reopen its finished status if the precise
    // Desktop turn/start is definitely newer than the file's last write.
    // Preserve UNKNOWN for ambiguous ordering or clock drift.
    if (row.status === 'finished' && completionAt === null) {
      const age = row.ageAtSourceMs;
      const ageValid = typeof age === 'number' && Number.isFinite(age) && age >= 0;
      const modifiedAt = ageValid ? sourceObservedAt - age :
        row.sourceId === 'local' && Number.isFinite(row.updatedAt)
          ? row.updatedAt : null;
      if (modifiedAt === null || !Number.isFinite(modifiedAt) ||
          modifiedAt >= event.at - FILE_FINISH_SAFETY_MS) continue;
    }
    if (row.status === 'working') continue; // Preserve existing, stronger evidence.
    row.status = 'working';
    row.finishedToken = null;
    row.evidenceKind = 'recent-start';
    row.statusReason =
      'Codex Desktop 日志确认近期 turn/start 已被接受，尚未看到对应结束事件；仅临时推断可能执行中。' +
      '若持续没有新的执行证据，将回退为状态未知（不是判定完成）';
  }
}


/** Desktop can produce many megabytes of logs in one long turn. Keep only
 * previously parsed (threadId, lifecycle, time) evidence, so a turn/start
 * is not lost when that original log line rotates out of the bounded tail.
 */
/** Normalize externally stored metadata before accepting it into the
 * transient event cache. Never trust a sidecar field as a path/command.
 */
export function parseSavedDesktopEvent(value: unknown, now = Date.now()): DesktopLogEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.threadId !== 'string' || !UUID.test(row.threadId) ||
      typeof row.at !== 'number' || !Number.isSafeInteger(row.at) || row.at <= 0 ||
      row.at > now + 5000 || now - row.at > MAX_PERSISTED_AGE_MS ||
      (row.type !== 'turn-start-accepted' && row.type !== 'turn-displayed-complete')) return null;
  if (row.type === 'turn-displayed-complete' &&
      (typeof row.turnId !== 'string' || !UUID.test(row.turnId))) return null;
  return { threadId: row.threadId.toLowerCase(), at: row.at, type: row.type,
    ...(row.type === 'turn-displayed-complete' ? { turnId: (row.turnId as string).toLowerCase() } : {}) };
}

/** Keep only lifecycle evidence (no log bodies). Retain long-turn ordering
 * across Monitor restarts, while projection explicitly labels stale starts
 * as unverified and allows any newer completion to take precedence.
 */
export class DesktopLogEventCache {
  private latest = new Map<string, DesktopLogEvent>();

  restore(records: readonly unknown[], now = Date.now()): void {
    for (const value of records.slice(0, MAX_PERSISTED_EVENTS * 2)) {
      const event = parseSavedDesktopEvent(value, now);
      if (!event) continue;
      const previous = this.latest.get(event.threadId);
      if (!previous || event.at > previous.at ||
          (event.at === previous.at && event.type === 'turn-displayed-complete')) {
        this.latest.set(event.threadId, event);
      }
    }
    this.prune(now);
  }

  snapshot(now = Date.now()): DesktopLogEvent[] {
    return [...this.latest.values()].map(item => parseSavedDesktopEvent(item, now))
      .filter((item): item is DesktopLogEvent => item !== null)
      .sort((a, b) => b.at - a.at).slice(0, MAX_PERSISTED_EVENTS);
  }

  private prune(now: number): void {
    for (const [threadId, event] of this.latest) {
      if (now - event.at > DESKTOP_LOG_EVENT_MAX_AGE_MS ||
          event.at > now + 5000) this.latest.delete(threadId);
    }
    if (this.latest.size > MAX_PERSISTED_EVENTS) {
      const keep = new Map(this.snapshot(now).map(item => [item.threadId, item]));
      this.latest = keep;
    }
  }

  observe(events: ReadonlyMap<string, DesktopLogEvent>, now = Date.now()): Map<string, DesktopLogEvent> {
    for (const [threadId, event] of events) {
      // Live events may be older than the short restored-event TTL. They
      // still need valid structure, provenance type and a bounded 24h age.
      if (!UUID.test(threadId) ||
          (event.type !== 'turn-start-accepted' && event.type !== 'turn-displayed-complete') ||
          !Number.isSafeInteger(event.at) || event.at <= 0 ||
          event.at > now + 5000 || now - event.at > DESKTOP_LOG_EVENT_MAX_AGE_MS ||
          (event.type === 'turn-displayed-complete' &&
            (!event.turnId || !UUID.test(event.turnId)))) continue;
      const prior = this.latest.get(threadId);
      if (!prior || event.at > prior.at ||
          (event.at === prior.at && event.type === 'turn-displayed-complete')) {
        this.latest.set(threadId, event);
      }
    }
    this.prune(now);
    return new Map(this.latest);
  }
}
