import { describe, expect, it } from 'vitest';
import { inferObservedActivity, isInternalWslDistro, normalizeRemote } from '../electron/collector';
import type { SessionRecord, SourceResult } from '../src/shared/types';

function source(session: SessionRecord): SourceResult {
  return { id: session.sourceId, label: 'Linux', kind: 'ssh', sessions: [session], error: null };
}
function record(id: string, updatedAt: number, byteSize: number): SessionRecord {
  return {
    key: `ssh:test:${id}`, id, sourceId: 'ssh:test', sourceLabel: 'Linux',
    workspace: '/tmp/example', title: null, status: 'unknown', statusReason: 'none',
    updatedAt, byteSize, startedAt: null,
  };
}

describe('source filtering', () => {
  it('ignores only known Docker Desktop internal WSL distributions', () => {
    expect(isInternalWslDistro('docker-desktop')).toBe(true);
    expect(isInternalWslDistro('  Docker-Desktop-Data ')).toBe(true);
    expect(isInternalWslDistro('Ubuntu-22.04')).toBe(false);
    expect(isInternalWslDistro('docker-work')).toBe(false);
  });
});

describe('observed file-growth evidence', () => {
  it('does not equate an initial fresh mtime with running', () => {
    const first = source(record('growing1', 1_000_000, 100));
    inferObservedActivity([first], 1_001_000);
    expect(first.sessions[0]?.status).toBe('unknown');
    const grown = source(record('growing1', 1_002_000, 130));
    inferObservedActivity([grown], 1_002_500);
    expect(grown.sessions[0]?.status).toBe('working');
    expect(grown.sessions[0]?.statusReason).toMatch(/日志文件增长/);
    const stale = source(record('growing1', 1_002_000, 130));
    inferObservedActivity([stale], 1_060_000);
    expect(stale.sessions[0]?.status).toBe('working');
    expect(stale.sessions[0]?.statusReason).toMatch(/上下文压缩/);
    const expired = source(record('growing1', 1_002_000, 130));
    inferObservedActivity([expired], 1_002_000 + 8 * 60_000 + 1);
    expect(expired.sessions[0]?.status).toBe('unknown');
  });
  it('never overwrites explicit completion or uses timestamps alone', () => {
    inferObservedActivity([], 1_000_000);
    inferObservedActivity([source(record('growing2', 1_001_000, 100))], 1_001_000);
    const touched = source(record('growing2', 1_002_000, 100));
    inferObservedActivity([touched], 1_002_200);
    expect(touched.sessions[0]?.status).toBe('unknown');
    const completed = source({ ...record('growing2', 1_003_000, 120), status: 'finished' });
    inferObservedActivity([completed], 1_003_000);
    expect(completed.sessions[0]?.status).toBe('finished');
  });
});


describe('remote status normalization', () => {
  it('preserves abnormal terminal states for WSL/SSH without turning them into unknown', () => {
    const entries = [
      { id: 'completed', status: 'finished', updatedAt: 1000, finishedToken: 'done|1' },
      { id: 'cancelled', status: 'interrupted', updatedAt: 1001, interruptedToken: 'abort|2',
        interruptionTokens: ['abort|1', 'abort|2', 'abort|2'] },
      { id: 'failed', status: 'failed', updatedAt: 1002 },
      { id: 'invalid', status: 'nonsense', updatedAt: 1003 },
    ];
    const rows = normalizeRemote(entries, 'ssh:server', 'Server');
    expect(rows.map(row => row.status)).toEqual(['finished', 'interrupted', 'failed', 'unknown']);
    expect(rows[1]?.interruptedToken).toBe('abort|2');
    expect(rows[1]?.interruptionTokens).toEqual(['abort|1', 'abort|2']);
  });
});
