import { describe, expect, it } from 'vitest';
import { projectSessionsToLocalTime, sessionObservedAt } from '../src/shared/session-time';
import { filterSessions } from '../src/shared/monitor-view';
import type { ScanResponse, SessionRecord } from '../src/shared/types';

const NOW = 1_800_000_000_000;
const row = (id: string, sourceId: string, clock: number, age: number): SessionRecord => ({
  id, key: sourceId + ':' + id, sourceId, sourceLabel: sourceId,
  workspace: '/repo', title: id, updatedAt: clock, ageAtSourceMs: age,
  status: 'finished', statusReason: 'durable', startedAt: null,
});

describe('source-scoped clock projection', () => {
  it('uses each source capture time despite another source moving global scan time', () => {
    const remote = row('remote', 'ssh:remote', NOW + 3_600_000 - 10_000, 10_000);
    const local = row('local', 'local', NOW + 24_000, 1_000);
    const scan: ScanResponse = {
      scannedAt: NOW + 90_000,
      sources: [
        {id:'ssh:remote', label:'Remote', kind:'ssh', capturedAt: NOW,
          sessions:[remote], error:null},
        {id:'local', label:'Windows', kind:'local', capturedAt:NOW + 25_000,
          sessions:[local], error:null},
      ],
    };
    const projected = projectSessionsToLocalTime(scan);
    expect(projected.map(s=>[s.id,s.updatedAt])).toEqual([
      ['remote', NOW - 10_000], ['local', NOW + 24_000],
    ]);
    expect(remote.updatedAt).toBe(NOW + 3_600_000 - 10_000); // raw evidence unchanged
    const again = projectSessionsToLocalTime({...scan, scannedAt: NOW + 600_000});
    expect(again.map(s=>s.updatedAt)).toEqual(projected.map(s=>s.updatedAt));
  });

  it('recency filters respect remote-relative age and preserve working exceptions', () => {
    const remote = row('recent', 'ssh:remote', NOW + 9 * 60_000, 30_000);
    const old = row('old', 'ssh:remote', NOW + 8 * 60_000, 8 * 24 * 60 * 60_000);
    const scan: ScanResponse = { scannedAt: NOW, sources: [
      {id:'ssh:remote', label:'Server', kind:'ssh', capturedAt: NOW,
        error:null, sessions:[remote, old]},
    ]};
    const projected = projectSessionsToLocalTime(scan);
    const options = {query:'', status:'all' as const, recentOnly:true,sourceId:null,workspaceId:null};
    expect(filterSessions(projected, options, NOW).map(s=>s.id)).toEqual(['recent']);
    const running = {...projected[1]!, status:'working' as const};
    expect(filterSessions([running], options, NOW)).toHaveLength(1);
  });

  it('does not manufacture timestamps for legacy rows without valid source age', () => {
    const r = row('legacy','ssh:remote',NOW - 2500,Number.NaN);
    expect(sessionObservedAt(r,{capturedAt:NOW})).toBe(r.updatedAt);
    expect(sessionObservedAt({...r,ageAtSourceMs:undefined},{capturedAt:undefined}))
      .toBe(r.updatedAt);
  });
});
