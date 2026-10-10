import type { SessionRecord, SessionStatus } from './types';
import { workspaceGroupKey } from './grouping';

export interface ViewFilter {
  query: string;
  status: SessionStatus | 'all';
  recentOnly: boolean;
  sourceId: string | null;
  workspaceId: string | null;
}

export interface StatusLane {
  id: 'working' | 'other' | 'finished';
  label: string;
  description: string;
  emptyLabel: string;
  sessions: SessionRecord[];
}

const LAST_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Applies the same filters to the status board, flat list and location grouping. */
export function filterSessions(rows: SessionRecord[], options: ViewFilter, now: number): SessionRecord[] {
  const query = options.query.trim().toLocaleLowerCase();
  return rows.filter(row => {
    if (options.recentOnly && now - row.updatedAt > LAST_WEEK_MS) return false;
    if (options.status !== 'all' && row.status !== options.status) return false;
    if (options.sourceId && row.sourceId !== options.sourceId) return false;
    if (options.workspaceId && workspaceGroupKey(row.sourceId, row.workspace) !== options.workspaceId) return false;
    if (!query) return true;
    return [row.title, row.workspace, row.sourceLabel, row.id].some(value =>
      value?.toLocaleLowerCase().includes(query));
  });
}

/** Unknown is never treated as pending approval; both remain visibly distinct. */
export function makeStatusLanes(rows: SessionRecord[]): StatusLane[] {
  const working = rows.filter(row => row.status === 'working');
  const pending = rows.filter(row => row.status === 'waiting');
  const unknown = rows.filter(row => row.status === 'unknown');
  const finished = rows.filter(row => row.status === 'finished');

  return [
    { id: 'working', label: '可能执行中', description: '近期有持续活动证据 · 推断',
      emptyLabel: '当前没有可确认的活动会话', sessions: working },
    { id: 'other', label: '状态待确认', description: '待处理与未知状态分别标记',
      emptyLabel: '没有等待或未知状态的会话', sessions: [...pending, ...unknown] },
    { id: 'finished', label: '最近完成', description: '已检测到本轮结束事件',
      emptyLabel: '近期没有已结束的会话', sessions: finished },
  ];
}
