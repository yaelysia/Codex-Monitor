import { describe, expect, it } from 'vitest';
import { SessionActivityTracker, SILENCE_GRACE_MS } from '../src/shared/activity-tracker';
import { AlertTracker } from '../src/shared/alert-tracker';
import type { SessionRecord, SourceResult, ScanResponse } from '../src/shared/types';

const NOW = 1_800_000_000_000;
function record(status: SessionRecord['status'], modifiedAt: number, bytes = 800): SessionRecord {
  return {
    key: 'ssh:server:session-one', id: 'session-one', sourceId: 'ssh:server',
    sourceLabel: 'Server', workspace: '/code', title: '重构程序',
    status, statusReason: 'status from rollout', updatedAt: modifiedAt,
    byteSize: bytes, startedAt: null,
  };
}
function sources(sessions: SessionRecord[], error: string | null = null): SourceResult[] {
  return [{ id: 'ssh:server', kind: 'ssh', label: 'Server', sessions, error }];
}
function scan(at: number, rows: SessionRecord[]): ScanResponse {
  return { scannedAt: at, sources: sources(rows) };
}

describe('compaction / long-operation activity continuity', () => {
  it('keeps an observed active turn tentative across 90 seconds of silent compaction', () => {
    const tracker = new SessionActivityTracker();
    tracker.annotate(sources([record('working', NOW - 10_000)]), NOW);
    const silent = record('unknown', NOW - 10_000);
    tracker.annotate(sources([silent]), NOW + 3 * 60_000);
    expect(silent.status).toBe('working');
    expect(silent.statusReason).toMatch(/上下文压缩/);
    expect(silent.statusReason).toMatch(/没有新日志/);
  });

  it('never renews activity evidence from the grace result itself', () => {
    const tracker = new SessionActivityTracker();
    tracker.annotate(sources([record('working', NOW)]), NOW);
    for (let seconds = 30; seconds < SILENCE_GRACE_MS / 1000; seconds += 30) {
      tracker.annotate(sources([record('unknown', NOW)]), NOW + seconds * 1000);
    }
    const expired = record('unknown', NOW);
    tracker.annotate(sources([expired]), NOW + SILENCE_GRACE_MS + 1);
    expect(expired.status).toBe('unknown');
  });

  it('does not assume a previously unknown session is active just because its mtime is recent', () => {
    const tracker = new SessionActivityTracker();
    const first = record('unknown', NOW);
    tracker.annotate(sources([first]), NOW);
    expect(first.status).toBe('unknown');
    const untouched = record('unknown', NOW);
    tracker.annotate(sources([untouched]), NOW + 3 * 60_000);
    expect(untouched.status).toBe('unknown');
  });

  it('never overrides explicit completion or waiting evidence', () => {
    const tracker = new SessionActivityTracker();
    tracker.annotate(sources([record('working', NOW)]), NOW);
    const terminal = record('finished', NOW + 120_000, 950);
    tracker.annotate(sources([terminal]), NOW + 120_000);
    expect(terminal.status).toBe('finished');
    const after = record('unknown', NOW + 120_000, 950);
    tracker.annotate(sources([after]), NOW + 140_000);
    expect(after.status).toBe('unknown');
    const pending = record('waiting', NOW + 142_000, 980);
    tracker.annotate(sources([pending]), NOW + 142_000);
    expect(pending.status).toBe('waiting');
  });

  it('does not stretch stale evidence across rollover, truncation, or clock rollback', () => {
    const tracker = new SessionActivityTracker();
    tracker.annotate(sources([record('working', NOW, 900)]), NOW);
    const rolled = record('unknown', NOW + 500, 100);
    tracker.annotate(sources([rolled]), NOW + 2 * 60_000);
    expect(rolled.status).toBe('unknown');
  });

  it('keeps evidence during a transient source error but expires it on the original clock', () => {
    const tracker = new SessionActivityTracker();
    tracker.annotate(sources([record('working', NOW)]), NOW);
    tracker.annotate(sources([], 'SSH disconnected'), NOW + 1 * 60_000);
    const afterRecovery = record('unknown', NOW);
    tracker.annotate(sources([afterRecovery]), NOW + 2 * 60_000);
    expect(afterRecovery.status).toBe('working');
    tracker.annotate(sources([], 'SSH disconnected'), NOW + 3 * 60_000);
    const tooLate = record('unknown', NOW);
    tracker.annotate(sources([tooLate]), NOW + SILENCE_GRACE_MS + 1000);
    expect(tooLate.status).toBe('unknown');
  });

  it('stays quiet during compaction, then emits exactly one real completion alert', () => {
    const activity = new SessionActivityTracker();
    const alerts = new AlertTracker();
    activity.annotate(sources([record('working', NOW)]), NOW);
    expect(alerts.observe(scan(NOW, [record('working', NOW)]), NOW)).toHaveLength(0);
    const quiet = record('unknown', NOW);
    activity.annotate(sources([quiet]), NOW + 150_000);
    expect(quiet.status).toBe('working');
    expect(alerts.observe(scan(NOW + 150_000, [quiet]), NOW + 150_000)).toHaveLength(0);
    const finished = record('finished', NOW + 155_000, 1200);
    finished.finishedToken = '2026-11-01T00:00:00Z|turn-1';
    activity.annotate(sources([finished]), NOW + 156_000);
    const events = alerts.observe(scan(NOW + 156_000, [finished]), NOW + 156_000);
    expect(events.map(e => e.kind)).toEqual(['finished']);
    expect(alerts.observe(scan(NOW + 168_000, [finished]), NOW + 168_000)).toHaveLength(0);
  });
});
