import { describe, expect, it } from 'vitest';
import { groupByExecutionLocation, workspaceGroupKey } from '../src/shared/grouping';
import { filterSessions, makeStatusLanes, recentParentCompletions } from '../src/shared/monitor-view';
import type { SessionRecord } from '../src/shared/types';

const NOW = 1_800_000_000_000;
function row(id: string, sourceId: string, workspace: string | null, status: SessionRecord['status'],
  updatedAt = NOW, title = 'Task'): SessionRecord {
  return {
    id, key: sourceId + ':' + id, title, sourceId, sourceLabel: sourceId,
    workspace, status, statusReason: 'test', updatedAt, startedAt: null,
  };
}

describe('hybrid workspace + status dashboard', () => {
  it('keeps full-path and execution-source identity when filtering sidebar locations', () => {
    const rows = [
      row('a', 'local', 'C:\\Work\\app', 'working'),
      row('b', 'local', 'C:\\Other\\app', 'unknown'),
      row('c', 'ssh:1', '/home/u/app', 'finished'),
      row('d', 'ssh:2', '/home/u/app', 'finished'),
    ];
    const groups = groupByExecutionLocation(rows);
    expect(groups).toHaveLength(3);
    const selected = groups.find(group => group.sourceId === 'local')?.workspaces
      .find(group => group.sessions[0]?.id === 'a');
    expect(selected).toBeDefined();
    const filtered = filterSessions(rows, {
      query: '', status: 'all', recentOnly: false, sourceId: 'local', workspaceId: selected!.key,
    }, NOW);
    expect(filtered.map(item => item.id)).toEqual(['a']);
    expect(workspaceGroupKey('local', 'c:/work/app/')).toBe(selected?.key);
  });

  it('applies title search, status and recency constraints across all views', () => {
    const rows = [
      row('a', 'local', '/repo', 'working', NOW, '修复 UI'),
      row('b', 'local', '/repo', 'finished', NOW - 8 * 24 * 60 * 60 * 1000, '另一任务'),
      row('c', 'ssh:one', '/repo2', 'unknown', NOW, '测试运行状态'),
    ];
    expect(filterSessions(rows, {
      query: 'ui', status: 'working', recentOnly: true, sourceId: null, workspaceId: null,
    }, NOW).map(item => item.id)).toEqual(['a']);
    expect(filterSessions(rows, {
      query: '', status: 'all', recentOnly: true, sourceId: null, workspaceId: null,
    }, NOW).map(item => item.id)).toEqual(['a', 'c']);
  });

  it('places actual waiting ahead of unknown without claiming unknown needs approval', () => {
    const lanes = makeStatusLanes([
      row('unknown', 'local', '/repo', 'unknown'),
      row('done', 'local', '/repo', 'finished'),
      row('running', 'local', '/repo', 'working'),
      row('waiting', 'local', '/repo', 'waiting'),
    ]);
    expect(lanes.map(lane => [lane.id, lane.sessions.map(item => item.id)])).toEqual([
      ['working', ['running']],
      ['other', ['waiting', 'unknown']],
      ['finished', ['done']],
    ]);
    expect(lanes[1]?.description).toMatch(/分别标记/);
  });
});


describe('explicit terminal statuses on the board', () => {
  it('keeps failures/interruption in the abnormal lane rather than recent successful completions', () => {
    const lanes = makeStatusLanes([
      { id: 'abort', key: 'local:abort', sourceId: 'local', sourceLabel: 'Windows',
        workspace: '/code', title: 'Aborted', status: 'interrupted', statusReason: 'cancelled',
        updatedAt: NOW, startedAt: null },
      { id: 'bad', key: 'local:bad', sourceId: 'local', sourceLabel: 'Windows',
        workspace: '/code', title: 'Failed', status: 'failed', statusReason: 'error',
        updatedAt: NOW, startedAt: null },
    ]);
    expect(lanes.find(l => l.id === 'finished')?.sessions).toHaveLength(0);
    expect(lanes.find(l => l.id === 'other')?.sessions.map(s => s.id)).toEqual(['bad', 'abort']);
  });
});


describe('floating recent completion list policy', () => {
  it('excludes child completions but keeps their sessions available in the main list', () => {
    const items = [
      row('child', 'ssh:one', '/project', NOW, 'finished'),
      row('root', 'ssh:one', '/project', NOW, 'finished'),
    ];
    items[0]!.isSubagent = true;
    items[0]!.ageAtSourceMs = 1000;
    items[1]!.isSubagent = false;
    items[1]!.ageAtSourceMs = 1000;
    const recent = recentParentCompletions(items, NOW + 12_000, NOW);
    expect(recent.map(s => s.id)).toEqual(['root']);
    expect(items.map(s => s.id)).toEqual(['child', 'root']);
  });
  it('uses remote age rather than cross-host time when showing recent completion', () => {
    const row = row('root', 'ssh:server', '/srv/app', NOW - 20 * 60 * 60 * 1000, 'finished');
    row.ageAtSourceMs = 2000;
    expect(recentParentCompletions([row], NOW, NOW)).toHaveLength(1);
    row.ageAtSourceMs = 26 * 60 * 60 * 1000;
    expect(recentParentCompletions([row], NOW, NOW)).toHaveLength(0);
  });
});
