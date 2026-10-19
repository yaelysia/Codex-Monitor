import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlertTracker, MAX_SEEN_ALERT_IDS } from '../src/shared/alert-tracker';
import type { AlertTrackerPersistence } from '../src/shared/alert-tracker';
import type { DesktopLogEvent } from '../src/shared/desktop-log-status';
import type { ScanResponse, SessionRecord, SourceResult } from '../src/shared/types';

const NOW = 1_800_000_000_000;
const uuid = (n: number) => n.toString(16).padStart(8, '0') + '-1111-4111-8111-111111111111';
function session(n: number, extra: Partial<SessionRecord> = {}): SessionRecord {
  return { key: 'local:' + uuid(n), id: uuid(n), sourceId: 'local', sourceLabel: 'Windows',
    title: 'Session', workspace: null, status: 'working', statusReason: 'working',
    updatedAt: NOW, ageAtSourceMs: 0, startedAt: null, ...extra };
}
function scan(rows: SessionRecord[]): ScanResponse {
  return { scannedAt: NOW, sources: [{ id: 'local', label: 'Windows', kind: 'local',
    error: null, sessions: rows }] };
}
function completion(row: SessionRecord, turn = uuid(1000)): DesktopLogEvent {
  return { type: 'turn-displayed-complete', threadId: row.id, turnId: turn, at: NOW };
}
function saved(ids: string[]): AlertTrackerPersistence {
  return { version: 1, muted: false, alerts: [], seenAlertIds: ids };
}
const token = (turn: string, at = NOW) => new Date(at).toISOString() + '|' + turn;
afterEach(() => vi.restoreAllMocks());

describe('completion hot paths preserve alert identity', () => {
  it('does not visit sessions or decode IDs when no completion can qualify', () => {
    const tracker = new AlertTracker();
    const source: SourceResult = { id: 'local', label: 'Windows', kind: 'local', error: null,
      get sessions(): SessionRecord[] { throw new Error('unnecessary session traversal'); } };
    const snapshot = { scannedAt: NOW, sources: [source] };
    const event = completion(session(1));
    for (const evidence of [[], [
      { ...event, type: 'turn-start-accepted' as const },
      { ...event, at: NOW - 120_001 },
      { ...event, at: NOW + 5001 },
      { ...event, turnId: undefined },
    ]]) expect(tracker.observeDesktopCompletions(snapshot, evidence, NOW - 60_000, NOW)).toEqual([]);
    expect(tracker.observeDesktopCompletions(snapshot, [event], NOW + 1, NOW)).toEqual([]);
  });

  it('decodes 500 saved IDs once, not once for each of 40 new completions', () => {
    const tracker = new AlertTracker();
    tracker.restore(saved(Array.from({ length: MAX_SEEN_ALERT_IDS }, (_, i) =>
      JSON.stringify(['local:history-' + i, 'finished', token(uuid(i + 2000))]))));
    const rows = Array.from({ length: 40 }, (_, i) => session(i + 1));
    const evidence = rows.map((row, i) => completion(row, uuid(i + 1000)));
    const parse = vi.spyOn(JSON, 'parse');
    const alerts = tracker.observeDesktopCompletions(scan(rows), evidence, NOW - 1000, NOW);
    const decodes = parse.mock.calls.length;
    parse.mockRestore();
    expect(alerts).toHaveLength(40);
    expect(decodes).toBe(MAX_SEEN_ALERT_IDS);
    const repeatParse = vi.spyOn(JSON, 'parse');
    const repeated = tracker.observeDesktopCompletions(scan(rows), evidence, NOW - 1000, NOW);
    const repeatedDecodes = repeatParse.mock.calls.length;
    repeatParse.mockRestore();
    expect(repeated).toEqual([]);
    expect(repeatedDecodes).toBe(0);
  });

  it.each(['filesystem-first', 'desktop-first'])('deduplicates across channels: %s', order => {
    const tracker = new AlertTracker();
    const row = session(1), turn = uuid(1000);
    tracker.observe(scan([row]), NOW - 1);
    const terminal = scan([{ ...row, status: 'finished', finishedToken: token(turn), updatedAt: NOW + 1 }]);
    const native = () => tracker.observeDesktopCompletions(scan([row]), [completion(row, turn)], NOW - 1000, NOW);
    const file = () => tracker.observe(terminal, NOW);
    const [first, second] = order === 'filesystem-first' ? [file, native] : [native, file];
    expect(first()).toHaveLength(1);
    expect(second()).toEqual([]);
  });

  it('updates the batch index for two filesystem entries of one turn', () => {
    const tracker = new AlertTracker(), row = session(1), turn = uuid(1000);
    tracker.observe(scan([row]), NOW - 1);
    expect(tracker.observe(scan([
      { ...row, status: 'finished', finishedToken: token(turn), updatedAt: NOW + 1 },
      { ...row, status: 'finished', finishedToken: token(turn, NOW + 1), updatedAt: NOW + 2 },
    ]), NOW)).toHaveLength(1);
  });

  it('retains legacy bare-token behavior rather than treating it as a canonical stored turn', () => {
    const tracker = new AlertTracker(), row = session(1), turn = uuid(1000);
    tracker.observe(scan([row]), NOW - 1);
    expect(tracker.observe(scan([
      { ...row, status: 'finished', finishedToken: turn, updatedAt: NOW + 1 },
      { ...row, status: 'finished', finishedToken: token(turn), updatedAt: NOW + 2 },
    ]), NOW)).toHaveLength(2);
  });

  it('rechecks a legacy desktop token added after the batch index was built', () => {
    const tracker = new AlertTracker(), row = session(1), other = session(2), turn = uuid(1000);
    tracker.observe(scan([row, other]), NOW - 1);
    expect(tracker.observe(scan([
      { ...other, status: 'finished', finishedToken: token(uuid(1001)), updatedAt: NOW + 1 },
      { ...row, status: 'finished', finishedToken: 'desktop:' + turn, updatedAt: NOW + 1 },
      { ...row, status: 'finished', finishedToken: token(turn), updatedAt: NOW + 2 },
    ]), NOW)).toHaveLength(2);
  });

  it('ignores malformed legacy IDs, keeps exact casing, and scopes a turn to its session', () => {
    const tracker = new AlertTracker(), row = session(1), other = session(2), turn = uuid(0xabcdef);
    tracker.restore(saved(['not-json', '{}', JSON.stringify([row.key, 'waiting', token(turn)]),
      JSON.stringify([row.key, 'finished', token(turn.toUpperCase())]),
      JSON.stringify([other.key, 'finished', token(turn)])]));
    expect(tracker.observeDesktopCompletions(scan([row]), [completion(row, turn)], NOW - 1000, NOW)).toHaveLength(1);
    const next = new AlertTracker();
    next.restore(tracker.snapshot());
    expect(next.observeDesktopCompletions(scan([row]), [completion(row, turn)], NOW - 1000, NOW)).toEqual([]);
  });

  it('does not mark ineligible evidence seen or suppress a later eligible event', () => {
    const tracker = new AlertTracker(), row = session(1), event = completion(row);
    for (const extra of [{ isSubagent: true }, { pendingQuestionToken: 'q' },
      { status: 'waiting' as const }, { status: 'failed' as const }, { status: 'interrupted' as const }]) {
      expect(tracker.observeDesktopCompletions(scan([{ ...row, ...extra }]), [event], NOW - 1000, NOW)).toEqual([]);
    }
    const offline = scan([row]);
    offline.sources[0]!.error = 'disconnected';
    expect(tracker.observeDesktopCompletions(offline, [event], NOW - 1000, NOW)).toEqual([]);
    expect(tracker.observeDesktopCompletions(scan([row]), [event, event], NOW - 1000, NOW)).toHaveLength(1);
  });

  it('shares terminal-marker logic without changing order, reasons, or duplicate suppression', () => {
    const tracker = new AlertTracker(), row = session(1);
    tracker.observe(scan([row]), NOW - 1);
    const interrupted = token(uuid(1001)), failed = token(uuid(1002));
    const updated = { ...row, updatedAt: NOW + 1, pendingQuestionToken: 'q',
      interruptionTokens: [interrupted, interrupted], failureTokens: [failed, failed] };
    const alerts = tracker.observe(scan([updated]), NOW);
    expect(alerts.map(alert => alert.kind)).toEqual(['interrupted', 'failed', 'waiting']);
    expect(alerts[0]!.statusReason).toBe('检测到本轮中断事件（即使后续轮次已经开始或结束）');
    expect(alerts[1]!.statusReason).toBe('检测到本轮失败结束事件（后续轮次可能已重新开始）');
    expect(tracker.observe(scan([updated]), NOW + 1)).toEqual([]);
  });

  it('counts only newly acknowledged IDs without mutating previously returned alerts', () => {
    const tracker = new AlertTracker(), row = session(1);
    const [alert] = tracker.observeDesktopCompletions(scan([row]), [completion(row)], NOW - 1000, NOW);
    const before = tracker.getAlerts();
    expect(tracker.acknowledgeMany([alert!.id, alert!.id, 'absent'])).toBe(1);
    expect(alert!.read).toBe(false);
    expect(before[0]!.read).toBe(false);
    expect(tracker.getAlerts()[0]!.read).toBe(true);
    expect(tracker.acknowledgeMany([alert!.id])).toBe(0);
    expect(tracker.acknowledgeMany([])).toBe(0);
    expect(tracker.observeDesktopCompletions(scan([row]), [completion(row, uuid(1002))], NOW - 1000, NOW)[0]!.read).toBe(false);
  });
});
