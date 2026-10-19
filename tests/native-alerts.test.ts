import { describe, expect, it } from 'vitest';
import { AlertTracker } from '../src/shared/alert-tracker';
import type { ScanResponse, SessionRecord } from '../src/shared/types';
const NOW = 1_800_000_000_000;
function snapshot(patch: Partial<SessionRecord> = {}): ScanResponse {
  return { scannedAt: NOW, sources: [{ id: 'local', label: 'Local', kind: 'local', error: null,
    sessions: [{ id: 'thread', key: 'local:thread', sourceId: 'local', sourceLabel: 'Local',
      status: 'waiting', statusReason: 'test', title: 'test', workspace: null, updatedAt: NOW,
      ageAtSourceMs: 0, startedAt: null, nativeStatus: { state: 'active', flags: ['waitingOnUserInput'] }, ...patch }] }] };
}
describe('native waiting alerts reuse the existing inbox', () => {
  it('honors kind settings and exact identities without advancing filesystem history', () => {
    const tracker = new AlertTracker(), scan = snapshot();
    expect(tracker.observeNativeWaiting(scan, ['wrong'], NOW)).toEqual([]);
    tracker.setNotificationKindEnabled('waiting', false);
    const alerts = tracker.observeNativeWaiting(scan, ['local:thread'], NOW);
    expect(alerts).toHaveLength(1); expect(alerts[0]).toMatchObject({ kind: 'waiting', read: true, questionText: null });
    expect(tracker.observe(snapshot({ status: 'finished', finishedToken: 'new-turn' }), NOW + 1)).toEqual([]);
  });
  it('does not turn idle/systemError, child sessions or failed sources into waiting alerts', () => {
    for (const patch of [{ isSubagent: true }, { status: 'unknown' as const },
      { nativeStatus: { state: 'idle' as const, flags: [] } }, { pendingQuestionToken: 'already-in-log' }]) {
      expect(new AlertTracker().observeNativeWaiting(snapshot(patch), ['local:thread'], NOW)).toEqual([]);
    }
    const scan = snapshot(); scan.sources[0]!.error = 'offline';
    expect(new AlertTracker().observeNativeWaiting(scan, ['local:thread'], NOW)).toEqual([]);
  });
  it('deduplicates a later persisted waiting marker during the confirmed native episode', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot({ status: 'working', nativeStatus: undefined }), NOW);
    const first = tracker.observeNativeWaiting(snapshot(), ['local:thread'], NOW + 1);
    expect(first).toHaveLength(1);
    tracker.acknowledge(first[0]!.id);
    expect(tracker.observe(snapshot({ nativeStatus: undefined, pendingQuestionToken: 'q1', updatedAt: NOW + 2 }), NOW + 2)).toEqual([]);
    tracker.retainNativeWaiting(new Set());
    expect(tracker.observe(snapshot({ nativeStatus: undefined, pendingQuestionToken: 'q2', updatedAt: NOW + 3 }), NOW + 3)).toHaveLength(1);
  });
  it('does not duplicate an existing unread persisted waiting notice', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot({ status: 'working', nativeStatus: undefined }), NOW);
    tracker.observe(snapshot({ nativeStatus: undefined, pendingQuestionToken: 'q1', updatedAt: NOW + 1 }), NOW + 1);
    expect(tracker.observeNativeWaiting(snapshot(), ['local:thread'], NOW + 2)).toEqual([]);
    expect(tracker.getAlerts()).toHaveLength(1);
  });
});
