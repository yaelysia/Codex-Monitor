import { describe, expect, it } from 'vitest';
import { freshNative, parseNativeThread, projectNativeScan, NATIVE_SAMPLE_TTL_MS,
  type NativeSample } from '../src/shared/native-state';
import type { ScanResponse, SessionRecord } from '../src/shared/types';
const NOW = 1_800_000_000_000;
const id = '019a1020-0000-7000-8000-777788889999';
function scan(patch: Partial<SessionRecord> = {}): ScanResponse {
  return { scannedAt: NOW, sources: ['local', 'ssh:server'].map(sourceId => ({
    id: sourceId, label: sourceId, kind: sourceId === 'local' ? 'local' : 'ssh', error: null,
    capturedAt: NOW, sessions: [{ id, key: sourceId + ':' + id, sourceId, sourceLabel: sourceId,
      title: 'private title', workspace: '/private/path', status: 'unknown', statusReason: 'log',
      updatedAt: NOW - 1000, ageAtSourceMs: 1000, startedAt: null, ...patch }],
  })) };
}
function sample(patch: Partial<NativeSample> = {}): NativeSample {
  return { key: 'local:' + id, sourceId: 'local', at: NOW, state: 'active', flags: [], isSubagent: false, ...patch };
}
function apply(base: ScanResponse, value = sample(), now = NOW) {
  return projectNativeScan(base, new Map([[value.key, value]]), now)!;
}

describe('strict native metadata projection', () => {
  it('recognizes only exact thread identity, supported states and complete active flags', () => {
    expect(parseNativeThread({ id, status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnApproval'] } }, id))
      .toEqual({ state: 'active', flags: ['waitingOnApproval'], isSubagent: false });
    for (const status of [{ type: 'active' }, { type: 'active', activeFlags: ['newFlag'] },
      { type: 'finished' }, null, 'active']) expect(parseNativeThread({ id, status }, id)).toBeNull();
    expect(parseNativeThread({ id: 'wrong', status: { type: 'idle' } }, id)).toBeNull();
    expect(parseNativeThread({ id, status: { type: 'active', activeFlags: [] }, parentThreadId: 'parent' }, id)?.isSubagent).toBe(true);
    expect(parseNativeThread({ id, status: { type: 'idle' }, source: { subAgent: {} } }, id)?.isSubagent).toBe(true);
  });
  it('overlays one source only, never mutates the filesystem snapshot', () => {
    const base = scan(), before = JSON.stringify(base);
    const result = apply(base);
    expect(result.sources[0]!.sessions[0]!.status).toBe('working');
    expect(result.sources[0]!.sessions[0]!.nativeStatus?.state).toBe('active');
    expect(result.sources[1]).toBe(base.sources[1]);
    expect(JSON.stringify(base)).toBe(before);
    expect(apply(base, sample({ sourceId: 'ssh:server' }))).toBe(base);
  });
  it('keeps waiting and async persisted questions without inventing answer text', () => {
    const row = apply(scan(), sample({ flags: ['waitingOnUserInput'] })).sources[0]!.sessions[0]!;
    expect(row.status).toBe('waiting'); expect(row.questionText).toBeUndefined();
    const base = scan({ status: 'waiting', pendingQuestionToken: 'async-question', questionText: 'keep this question' });
    const projected = apply(base).sources[0]!.sessions[0]!;
    expect(projected.status).toBe('waiting'); expect(projected.pendingQuestionToken).toBe('async-question');
  });
  it('does not equate idle or systemError to successful/failed turns', () => {
    for (const state of ['idle', 'systemError'] as const) {
      const row = apply(scan({ status: 'working' }), sample({ state })).sources[0]!.sessions[0]!;
      expect(row.status).toBe('unknown'); expect(row.finishedToken).toBeUndefined();
    }
    for (const status of ['finished', 'failed', 'interrupted'] as const)
      expect(apply(scan({ status }), sample({ state: 'idle' })).sources[0]!.sessions[0]!.status).toBe(status);
  });
  it('drops stale/future samples, unavailable/child sources and unknown native states', () => {
    const base = scan();
    expect(freshNative(sample(), NOW + NATIVE_SAMPLE_TTL_MS)).toBe(true);
    for (const value of [sample({ at: NOW + 1 }), sample({ at: NOW - NATIVE_SAMPLE_TTL_MS - 1 }),
      sample({ isSubagent: true }), sample({ state: 'notLoaded' }), sample({ state: 'unknown' })])
      expect(apply(base, value)).toBe(base);
    const child = scan({ isSubagent: true }); expect(apply(child)).toBe(child);
    base.sources[0]!.error = 'private error'; expect(apply(base)).toBe(base);
    base.sources[0]!.error = null; base.sources[0]!.stale = true; expect(apply(base)).toBe(base);
  });
  it('lets newer file evidence beat an in-flight native read, including source clock adjustment', () => {
    const base = scan({ status: 'failed', updatedAt: NOW + 5, ageAtSourceMs: 0 });
    base.sources[0]!.capturedAt = NOW + 5;
    expect(apply(base, sample(), NOW + 10)).toBe(base);
    expect(apply(base, sample({ at: NOW + 6 }), NOW + 10).sources[0]!.sessions[0]!.status).toBe('working');
    const remote = sample({ key: 'ssh:server:' + id, sourceId: 'ssh:server' });
    base.sources[1]!.sessions[0]!.updatedAt = NOW + 3600000;
    base.sources[1]!.sessions[0]!.ageAtSourceMs = 1000;
    expect(apply(base, remote).sources[1]!.sessions[0]!.nativeStatus?.state).toBe('active');
  });
});
