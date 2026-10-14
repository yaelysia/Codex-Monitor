import { describe, expect, it } from 'vitest';
import { groupByExecutionLocation } from '../src/shared/grouping';
import type { SessionRecord } from '../src/shared/types';

function session(id: string, sourceId: string, workspace: string | null,
  updatedAt: number, status: SessionRecord['status'] = 'finished'): SessionRecord {
  return {
    id, sourceId, sourceLabel: sourceId, key: `${sourceId}:${id}`, title: `Task ${id}`,
    workspace, updatedAt, startedAt: null, byteSize: 100, status, statusReason: '',
  };
}

describe('execution location grouping', () => {
  it('groups by machine then absolute directory, not just directory basename', () => {
    const groups = groupByExecutionLocation([
      session('a', 'local', 'C:\\work\\app', 10),
      session('b', 'local', 'C:\\other\\app', 20),
      session('c', 'ssh:one', '/home/dev/app', 30),
      session('d', 'ssh:two', '/home/dev/app', 40),
      session('e', 'local', 'c:/work/app/', 50),
    ]);
    expect(groups).toHaveLength(3);
    const local = groups.find(g => g.sourceId === 'local');
    expect(local?.workspaces).toHaveLength(2);
    expect(local?.workspaces.find(w => w.sessions.some(s => s.id === 'a'))?.sessions.map(s => s.id)).toEqual(['e', 'a']);
    expect(groups.filter(g => g.sourceId.startsWith('ssh:')).every(g => g.workspaces.length === 1)).toBe(true);
  });

  it('shows active workspaces first and preserves unknown cwd group', () => {
    const groups = groupByExecutionLocation([
      session('done', 'local', '/workspace/old', 100, 'finished'),
      session('running', 'local', '/workspace/live', 80, 'working'),
      session('none', 'local', null, 40, 'unknown'),
    ]);
    expect(groups[0]?.workspaces[0]).toMatchObject({ workspace: '/workspace/live', working: 1 });
    expect(groups[0]?.workspaces.find(w => w.workspace === null)?.sessions.map(s => s.id)).toEqual(['none']);
    expect(groups[0]).toMatchObject({ count: 3, working: 1, waiting: 0, latest: 100 });
  });

  it('does not mutate the input session list', () => {
    const original = [session('old', 'local', '/repo', 1), session('new', 'local', '/repo', 2)];
    groupByExecutionLocation(original);
    expect(original.map(s => s.id)).toEqual(['old', 'new']);
  });
});
