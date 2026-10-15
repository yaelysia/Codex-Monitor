import { describe, expect, it } from 'vitest';
import { groupByExecutionLocation, workspaceGroupKey } from '../src/shared/grouping';
import { filterSessions, filterSessionsForView, makeStatusLanes, recentParentCompletions, summarizeDashboardSessions } from '../src/shared/monitor-view';
import type { SessionRecord, ScanResponse } from '../src/shared/types';
import { projectSessionsToLocalTime, sessionObservedAt } from '../src/shared/session-time';

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

  it('keeps explicitly possible-running long tasks visible despite an old file timestamp', () => {
    const rows = [
      row('old-running', 'local', '/repo', 'working', NOW - 10 * 24 * 60 * 60_000),
      row('old-unknown', 'local', '/repo', 'unknown', NOW - 10 * 24 * 60 * 60_000),
    ];
    expect(filterSessions(rows, {
      query: '', status: 'all', recentOnly: true, sourceId: null, workspaceId: null,
    }, NOW).map(x => x.id)).toEqual(['old-running']);
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
      row('child', 'ssh:one', '/project', 'finished', NOW),
      row('root', 'ssh:one', '/project', 'finished', NOW),
    ];
    items[0]!.isSubagent = true;
    items[0]!.ageAtSourceMs = 1000;
    items[1]!.isSubagent = false;
    items[1]!.ageAtSourceMs = 1000;
    const recent = recentParentCompletions(items, NOW + 12_000);
    expect(recent.map(s => s.id)).toEqual(['root']);
    expect(items.map(s => s.id)).toEqual(['child', 'root']);
  });
  it('uses remote age rather than cross-host time when showing recent completion', () => {
    const completion = row('root', 'ssh:server', '/srv/app', 'finished', NOW - 20 * 60 * 60 * 1000);
    completion.ageAtSourceMs = 2000;
    const snapshot = (capturedAt: number): ScanResponse => ({
      scannedAt: NOW + 30_000,
      sources: [{id: 'ssh:server', label: 'Server', kind: 'ssh',
        capturedAt, error: null, sessions: [completion]}],
    });
    expect(recentParentCompletions(projectSessionsToLocalTime(snapshot(NOW)), NOW)).toHaveLength(1);
    completion.ageAtSourceMs = 26 * 60 * 60 * 1000;
    expect(recentParentCompletions(projectSessionsToLocalTime(snapshot(NOW)), NOW)).toHaveLength(0);
  });
});


describe('dashboard waiting and abnormal counts', () => {
  it('never counts interrupted or failed turns as waiting for user input', () => {
    // Reproduces the observed dashboard mismatch: waiting=0, interrupted=2.
    const rows = [
      row('interrupted-a', 'local', '/a', 'interrupted'),
      row('interrupted-b', 'ssh:server', '/b', 'interrupted'),
      row('working', 'local', '/c', 'working'),
      row('finished', 'local', '/d', 'finished'),
    ];
    const counts = summarizeDashboardSessions(rows);
    expect(counts.pending).toHaveLength(0);
    expect(counts.abnormal.map(x => x.id)).toEqual(['interrupted-a', 'interrupted-b']);
    expect(counts.working.map(x => x.id)).toEqual(['working']);
    expect(counts.pending.concat(counts.abnormal).map(x => x.status)).not.toContain('finished');
  });

  it('uses actual waiting state and opens only its rows in waiting filter', () => {
    const pending = row('pending', 'local', '/proj', 'waiting');
    pending.pendingQuestionToken = 'question1';
    const terminated = row('failed', 'local', '/proj', 'failed');
    const abort = row('interrupted', 'local', '/proj', 'interrupted');
    const all = [pending, terminated, abort];
    const summary = summarizeDashboardSessions(all);
    expect(summary.pending.map(x => x.id)).toEqual(['pending']);
    expect(summary.abnormal.map(x => x.id)).toEqual(['failed', 'interrupted']);
    const filter = (status: 'waiting' | 'abnormal') => filterSessions(all, {
      query: '', status, recentOnly: true, sourceId: null, workspaceId: null,
    }, NOW).map(x => x.id);
    expect(filter('waiting')).toEqual(['pending']);
    expect(filter('abnormal')).toEqual(['failed', 'interrupted']);
  });

  it('keeps counters and navigation within the same search/location scope', () => {
    const all = [
      row('wait-a', 'local', '/a', 'waiting', NOW, '需要确认'),
      row('wait-b', 'ssh:server', '/b', 'waiting', NOW, '另外一个'),
      row('abort-a', 'local', '/a', 'interrupted', NOW, '需要确认'),
    ];
    const options = { query: '需要确认', status: 'all' as const, recentOnly: true,
      sourceId: 'local', workspaceId: null };
    const shown = filterSessions(all, options, NOW);
    const groups = summarizeDashboardSessions(shown);
    expect(groups.pending.map(x => x.id)).toEqual(['wait-a']);
    expect(groups.abnormal.map(x => x.id)).toEqual(['abort-a']);
    expect(filterSessions(all, { ...options, status: 'waiting' }, NOW).map(x => x.id))
      .toEqual(groups.pending.map(x => x.id));
    expect(filterSessions(all, { ...options, status: 'abnormal' }, NOW).map(x => x.id))
      .toEqual(groups.abnormal.map(x => x.id));
  });
});

describe('session-list-only status filtering', () => {
  const rows = [
    row('pending', 'local', '/repo', 'waiting', NOW, '待确认'),
    row('running', 'local', '/repo', 'working', NOW, '任务执行'),
    row('interrupted', 'local', '/repo', 'interrupted', NOW, '本轮终止'),
    row('failed', 'ssh:host', '/elsewhere', 'failed', NOW, '另一项失败'),
  ];

  it('does not zero out dashboard tiles or machine matrix after filtering the list', () => {
    const options = {
      query: '', status: 'waiting' as const, recentOnly: true,
      sourceId: null, workspaceId: null,
    };
    expect(filterSessionsForView(rows, 'sessions', options, NOW).map(x => x.id))
      .toEqual(['pending']);
    for (const view of ['board', 'locations', 'chronicle'] as const) {
      const groups = summarizeDashboardSessions(filterSessionsForView(rows, view, options, NOW));
      expect(groups.pending.map(x => x.id)).toEqual(['pending']);
      expect(groups.abnormal.map(x => x.id)).toEqual(['interrupted', 'failed']);
      expect(groups.working.map(x => x.id)).toEqual(['running']);
    }
    // Entering all sessions normally clears the filter.
    expect(filterSessionsForView(rows, 'sessions', { ...options, status: 'all' }, NOW))
      .toHaveLength(4);
  });

  it('preserves search and location scope but never inherits list-only status', () => {
    const options = {
      query: '', status: 'working' as const, recentOnly: true,
      sourceId: 'local', workspaceId: null,
    };
    const board = filterSessionsForView(rows, 'board', options, NOW);
    expect(board.map(x => x.id)).toEqual(['pending', 'running', 'interrupted']);
    const list = filterSessionsForView(rows, 'sessions', options, NOW);
    expect(list.map(x => x.id)).toEqual(['running']);
  });
});
