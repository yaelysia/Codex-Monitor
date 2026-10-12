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


describe('subagent completion notification policy', () => {
  const parent = '00000000-0000-4000-8000-000000000001';
  const child = '00000000-0000-4000-8000-000000000002';

  it.each([
    ['SSH', 'ssh:box'],
    ['WSL', 'wsl:Ubuntu'],
    ['Windows', 'local'],
  ])('retains %s subagent sessions but suppresses completion alerts', (_platform, sourceId) => {
    const tracker = new AlertTracker();
    const root = { ...row('working', NOW, { sourceId, sourceLabel: _platform, ageAtSourceMs: 1000 }),
      key: sourceId + ':' + parent, id: parent, isSubagent: false };
    const spawn = { ...row('working', NOW, { sourceId, sourceLabel: _platform, ageAtSourceMs: 1000 }),
      key: sourceId + ':' + child, id: child, isSubagent: true, parentThreadId: parent };
    const snap = (at: number, sessions: SessionRecord[]): ScanResponse => ({
      scannedAt: at, sources: [{ id: sourceId, kind: sourceId === 'local' ? 'local' :
        sourceId.startsWith('wsl:') ? 'wsl' : 'ssh', label: _platform, sessions, error: null }],
    });
    tracker.observe(snap(NOW, [root, spawn]), NOW);
    const childDone = { ...spawn, status: 'finished' as const,
      updatedAt: NOW + 10000, ageAtSourceMs: 1000, finishedToken: 'child|done' };
    expect(tracker.observe(snap(NOW + 12000, [root, childDone]), NOW + 12000)).toEqual([]);
    const parentDone = { ...root, status: 'finished' as const,
      updatedAt: NOW + 22000, ageAtSourceMs: 1000, finishedToken: 'parent|done' };
    const notifications = tracker.observe(snap(NOW + 24000, [parentDone, childDone]), NOW + 24000);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sessionKey).toBe(root.key);
    expect(tracker.getAlerts().map(item => item.sessionKey)).toEqual([root.key]);
  });

  it('continues suppressing a child after a transient metadata omission', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW, { isSubagent: true })]), NOW);
    const completed = row('finished', NOW + 10000, {
      isSubagent: undefined, finishedToken: 'turn|done', ageAtSourceMs: 1200,
    });
    expect(tracker.observe(snapshot(NOW + 12000, [completed]), NOW + 12000)).toEqual([]);
  });

  it('suppresses child waiting alerts as well as child completion alerts', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW, { isSubagent: true })]), NOW);
    const waiting = row('waiting', NOW + 9000, {
      isSubagent: true, waitingToken: 'child|needs-input', ageAtSourceMs: 1000,
    });
    expect(tracker.observe(snapshot(NOW + 12000, [waiting]), NOW + 12000)).toEqual([]);
    expect(tracker.getAlerts()).toHaveLength(0);
  });

  it('keeps hiding subagent wait alerts if a later scan omits the child flag', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW, { isSubagent: true })]), NOW);
    const waiting = row('waiting', NOW + 9000, {
      isSubagent: undefined, waitingToken: 'child|needs-input', ageAtSourceMs: 1000,
    });
    expect(tracker.observe(snapshot(NOW + 12000, [waiting]), NOW + 12000)).toEqual([]);
  });

  it('does not infer child role from a title, cwd, or source machine name', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW, {
      title: 'subagent code review', sourceLabel: 'subagent SSH',
    })]), NOW);
    const completed = row('finished', NOW + 10000, {
      title: 'subagent code review', sourceLabel: 'subagent SSH',
      finishedToken: 'done|title', ageAtSourceMs: 1000,
    });
    expect(tracker.observe(snapshot(NOW + 12000, [completed]), NOW + 12000)
      .map(item => item.kind)).toEqual(['finished']);
  });
});


describe('new unanswered question alerts', () => {
  it('emits only a waiting notification for an async question after a finished turn', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW - 1000, { byteSize: 100 })]), NOW);
    const prompt = row('finished', NOW + 1000, {
      byteSize: 150, finishedToken: 'turn-1',
      pendingQuestionToken: 'async:question-a', questionText: '先发布哪个环境？', ageAtSourceMs: 900,
    });
    const alerts = tracker.observe(snapshot(NOW + 12000, [prompt]), NOW + 12000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: 'waiting', questionText: '先发布哪个环境？', sessionKey: prompt.key,
    });
    expect(tracker.observe(snapshot(NOW + 24000, [prompt]), NOW + 24000)).toHaveLength(0);
    tracker.acknowledge(alerts[0]!.id);
    expect(tracker.getAlerts()[0]?.read).toBe(true);
    // Unanswered questions do not re-appear as unread after later scans.
    expect(tracker.observe(snapshot(NOW + 36000, [
      { ...prompt, updatedAt: NOW + 36000, byteSize: 180 },
    ]), NOW + 36000)).toHaveLength(0);
  });
  it('can notify another question in the same still-running session', () => {
    const tracker = new AlertTracker();
    tracker.observe(snapshot(NOW, [row('working', NOW)]), NOW);
    const first = row('waiting', NOW + 1000, {
      pendingQuestionToken: 'blocking:a', waitingToken: 'blocking:a',
      questionText: 'First?', byteSize: 100,
    });
    expect(tracker.observe(snapshot(NOW + 12000, [first]), NOW + 12000)
      .map(a => a.kind)).toEqual(['waiting']);
    const second = { ...first, updatedAt: NOW + 14000, byteSize: 120,
      pendingQuestionToken: 'blocking:b', waitingToken: 'blocking:b', questionText: 'Second?' };
    expect(tracker.observe(snapshot(NOW + 24000, [second]), NOW + 24000)
      .map(a => a.kind)).toEqual(['waiting']);
  });
  it('does not classify old async questions as fresh alerts on first scan', () => {
    const tracker = new AlertTracker();
    expect(tracker.observe(snapshot(NOW, [row('finished', NOW - 60_000, {
      pendingQuestionToken: 'async:old', questionText: 'Outdated?',
    })]), NOW)).toEqual([]);
  });
});
