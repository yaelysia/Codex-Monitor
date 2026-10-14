import { describe, expect, it } from 'vitest';
import { pinnedRolloutsBySource, validPinnedRolloutPath, MAX_PINNED_ROLLOUTS } from
  '../src/shared/pinned-rollouts';
import type { ScanResponse, SessionRecord } from '../src/shared/types';
const NOW = 1_800_000_000_000;
const row = (id: number, status: SessionRecord['status'], child = false): SessionRecord => ({
  id: String(id), key:'local:'+id, sourceId:'local', sourceLabel:'Windows',
  workspace:null, title:null, updatedAt:NOW+id, startedAt:null,
  rolloutPath:'2026/10/12/rollout-'+id+'.jsonl', status, statusReason:'test',
  isSubagent:child,
});
describe('bounded known-active sessions over newest-file cap', () => {
  it('selects oldest still-working parents but no children or completed tasks', () => {
    const rows = Array.from({length:30},(_,i)=>row(i,'working'));
    rows.push(row(31,'finished'),row(32,'working',true));
    const snapshot: ScanResponse = {
      scannedAt:NOW,sources:[{id:'local',label:'Windows',kind:'local',error:null,sessions:rows}],
    };
    const selected = pinnedRolloutsBySource(snapshot).get('local');
    expect(selected).toHaveLength(MAX_PINNED_ROLLOUTS);
    expect(selected?.[0]).toContain('rollout-0.jsonl');
    expect(selected?.some(s=>s.includes('rollout-32'))).toBe(false);
  });
  it('disallows traversal/absolute/user-supplied paths', () => {
    for(const item of ['/tmp/foo.jsonl','2026/10/12/../secret.jsonl',
      '2026\\10\\12\\foo.jsonl','2026/10/12/a/../../secret.jsonl'])
      expect(validPinnedRolloutPath(item)).toBe(false);
    expect(validPinnedRolloutPath('2026/10/12/rollout-example.jsonl')).toBe(true);
  });
});
