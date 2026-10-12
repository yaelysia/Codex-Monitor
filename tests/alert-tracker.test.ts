import { describe, expect, it } from 'vitest';
import { AlertTracker } from '../src/shared/alert-tracker';
import type { ScanResponse, SessionRecord } from '../src/shared/types';

const NOW = 1_800_000_000_000;
function row(status: SessionRecord['status'], stamp: number, options: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: 'ssh:box:one', id: 'one', sourceId: 'ssh:box', sourceLabel: 'Server',
    workspace: '/src/work', title: '修复接口', status, statusReason: 'from rollout',
    updatedAt: stamp, startedAt: null, ...options,
  };
}
function snapshot(at: number, sessions: SessionRecord[], error: string | null = null): ScanResponse {
  return { scannedAt: at, sources: [{ id: 'ssh:box', label: 'Server', kind: 'ssh', sessions, error }] };
}

describe('cross-scan completion and waiting alerts', () => {
  it('does not flood historical or initially active sessions', () => {
    const tracker = new AlertTracker();
    expect(tracker.observe(snapshot(NOW, [
      row('working', NOW), row('finished', NOW - 1000, { key: 'ssh:box:old', id: 'old' }),
    ]), NOW)).toEqual([]);
    expect(tracker.getAlerts()).toHaveLength(0);
  });

  it('notifies a completion once, and never repeats on unchanged refreshes', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW - 5000)]), NOW);
    const alerts = tracker.observe(snapshot(NOW + 12_000, [
      row('finished', NOW + 10_000, { finishedToken: '2026-11-01T01:00:00Z|turn1' }),
    ]), NOW + 12_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('finished');
    expect(tracker.observe(snapshot(NOW + 24_000, [
      row('finished', NOW + 10_000, { finishedToken: '2026-11-01T01:00:00Z|turn1' }),
    ]), NOW + 24_000)).toEqual([]);
    expect(tracker.getAlerts()).toHaveLength(1);
    tracker.acknowledge(alerts[0]!.id);
    expect(tracker.getAlerts()[0]?.read).toBe(true);
  });

  it('detects separate completed turns even if two scans both show finished', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('finished', NOW - 2000, { finishedToken: 't1|1' })]), NOW);
    expect(tracker.observe(snapshot(NOW + 12_000, [
      row('finished', NOW + 10_000, { finishedToken: 't2|2' }),
    ]), NOW + 12_000).map(alert => alert.kind)).toEqual(['finished']);
  });

  it('keeps unknown different from waiting and never turns quiet files into waiting', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW)]), NOW);
    expect(tracker.observe(snapshot(NOW + 12_000, [
      row('unknown', NOW + 10_000),
    ]), NOW + 12_000)).toEqual([]);
    expect(tracker.observe(snapshot(NOW + 24_000, [
      row('waiting', NOW + 22_000, { waitingToken: 'pending|turn2' }),
    ]), NOW + 24_000).map(alert => alert.kind)).toEqual(['waiting']);
  });

  it('does not fabricate events after a failed SSH scan or an old reconnect', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW)]), NOW);
    expect(tracker.observe(snapshot(NOW + 12_000, [], 'SSH failed'), NOW + 12_000)).toEqual([]);
    expect(tracker.observe(snapshot(NOW + 600_000, [
      row('finished', NOW + 10_000),
    ]), NOW + 600_000)).toEqual([]);
  });

  it('ignores new old sessions but not a quick newly created and completed task', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, []), NOW);
    expect(tracker.observe(snapshot(NOW + 12_000, [
      row('finished', NOW - 400_000),
    ]), NOW + 12_000)).toEqual([]);
    expect(tracker.observe(snapshot(NOW + 24_000, [
      row('finished', NOW + 21_000, { key: 'ssh:box:two', id: 'two' }),
    ]), NOW + 24_000)).toHaveLength(1);
  });

  it('mutes notifications without losing event records', () => {
    const tracker = new AlertTracker();
    tracker.setMuted(true);
    tracker.observe(snapshot(NOW, [row('working', NOW)]), NOW);
    tracker.observe(snapshot(NOW + 12_000, [
      row('finished', NOW + 10_000),
    ]), NOW + 12_000);
    expect(tracker.getMuted()).toBe(true);
    expect(tracker.getAlerts()).toHaveLength(1);
  });
});


describe('remote SSH and WSL completion alerts', () => {
  it.each([
    ['SSH ahead of Windows', 8 * 60_000],
    ['WSL or SSH behind Windows', -9 * 60_000],
  ])('notifies a previously running remote task when %s', (_label, offset) => {
    const tracker = new AlertTracker();
    const baseline = NOW + offset;
    tracker.observe(snapshot(NOW, [row('working', baseline, { ageAtSourceMs: 5000, byteSize: 100 })]), NOW);
    const next = row('finished', baseline + 11_000, {
      ageAtSourceMs: 1000, byteSize: 130, finishedToken: 'server-event-time|turn2',
    });
    const alerts = tracker.observe(snapshot(NOW + 12_000, [next]), NOW + 12_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe('finished');
    expect(alerts[0]?.sourceLabel).toBe('Server');
    expect(tracker.observe(snapshot(NOW + 24_000, [next]), NOW + 24_000)).toEqual([]);
  });

  it('recognizes different finished turn tokens even when the filesystem mtime is unchanged', () => {
    const tracker = new AlertTracker();
    const old = row('finished', NOW + 5 * 60_000, {
      finishedToken: 'remote|turn-a', byteSize: 1024, ageAtSourceMs: 5000,
    });
    tracker.observe(snapshot(NOW, [old]), NOW);
    const latest = row('finished', NOW + 5 * 60_000, {
      finishedToken: 'remote|turn-b', byteSize: 1024, ageAtSourceMs: 3000,
    });
    expect(tracker.observe(snapshot(NOW + 12_000, [latest]), NOW + 12_000)
      .map(item => item.kind)).toEqual(['finished']);
    expect(tracker.observe(snapshot(NOW + 24_000, [latest]), NOW + 24_000)).toEqual([]);
  });

  it('accepts a new fast-completed remote session after the first successful scan', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, []), NOW);
    const freshRemote = row('finished', NOW + 600_000, {
      ageAtSourceMs: 1500, finishedToken: 'timestamp|new', byteSize: 800,
    });
    expect(tracker.observe(snapshot(NOW + 12_000, [freshRemote]), NOW + 12_000)
      .map(item => item.kind)).toEqual(['finished']);
  });

  it('ignores old remote records on reconnect despite a new status', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW, { ageAtSourceMs: 0 })]), NOW);
    tracker.observe(snapshot(NOW + 12_000, [], 'SSH unavailable'), NOW + 12_000);
    const stale = row('finished', NOW + 60_000, {
      ageAtSourceMs: 450_000, finishedToken: 'old|turn', byteSize: 900,
    });
    expect(tracker.observe(snapshot(NOW + 600_000, [stale]), NOW + 600_000)).toEqual([]);
  });

  it('does not emit alerts on the first scan of a newly configured remote source', () => {
    const tracker = new AlertTracker();
    expect(tracker.observe(snapshot(NOW, [
      row('finished', NOW + 600_000, { ageAtSourceMs: 1000, finishedToken: 'first|turn' }),
    ]), NOW)).toEqual([]);
  });

  it('requires new file or event evidence and avoids duplicate completed turns', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW, { ageAtSourceMs: 0, byteSize: 800 })]), NOW);
    const finished = row('finished', NOW, { ageAtSourceMs: 0, byteSize: 800 });
    expect(tracker.observe(snapshot(NOW + 12_000, [finished]), NOW + 12_000)).toEqual([]);
    const actual = row('finished', NOW, { ageAtSourceMs: 0, byteSize: 850, finishedToken: 'end|turn-2' });
    expect(tracker.observe(snapshot(NOW + 24_000, [actual]), NOW + 24_000)).toHaveLength(1);
    const after = row('finished', NOW + 10_000, {
      ageAtSourceMs: 0, byteSize: 900, finishedToken: 'end|turn-2',
    });
    expect(tracker.observe(snapshot(NOW + 36_000, [after]), NOW + 36_000)).toEqual([]);
  });
});
