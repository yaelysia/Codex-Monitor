import type { SessionRecord, SessionStatus } from './types';
import { workspaceGroupKey } from './grouping';

export interface ViewFilter {
  query: string;
  status: SessionStatus | 'all' | 'abnormal';
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
    // A legitimately running long turn may not write a rollout for days.
    // "Recent only" must not hide its execution row solely by file mtime.
    if (options.recentOnly && row.status !== 'working' &&
        now - row.updatedAt > LAST_WEEK_MS) return false;
    if (options.status === 'abnormal' &&
        row.status !== 'failed' && row.status !== 'interrupted') return false;
    if (options.status !== 'all' && options.status !== 'abnormal' &&
        row.status !== options.status) return false;
    if (options.sourceId && row.sourceId !== options.sourceId) return false;
    if (options.workspaceId && workspaceGroupKey(row.sourceId, row.workspace) !== options.workspaceId) return false;
    if (!query) return true;
    return [row.title, row.workspace, row.sourceLabel, row.id].some(value =>
      value?.toLocaleLowerCase().includes(query));
  });
}

/** "待处理" is only a waiting status, not any prior failed/interrupted turn.
 * Each group is disjoint, so the board never overstates requests for input.
 */
export function summarizeDashboardSessions(rows: SessionRecord[]) {
  return {
    pending: rows.filter(row => row.status === 'waiting'),
    abnormal: rows.filter(row => row.status === 'failed' || row.status === 'interrupted'),
    working: rows.filter(row => row.status === 'working'),
  };
}

/** Unknown is never treated as pending approval; both remain visibly distinct. */
export function makeStatusLanes(rows: SessionRecord[]): StatusLane[] {
  const working = rows.filter(row => row.status === 'working');
  const pending = rows.filter(row => row.status === 'waiting');
  const unknown = rows.filter(row => row.status === 'unknown');
  const interrupted = rows.filter(row => row.status === 'interrupted');
  const failed = rows.filter(row => row.status === 'failed');
  const finished = rows.filter(row => row.status === 'finished');

  return [
    { id: 'working', label: '可能执行中', description: '近期有持续活动证据 · 推断',
      emptyLabel: '当前没有可确认的活动会话', sessions: working },
    { id: 'other', label: '状态待确认', description: '待处理、中断、失败与未知状态分别标记',
      emptyLabel: '没有等待、异常或未知状态的会话', sessions: [...pending, ...failed, ...interrupted, ...unknown] },
    { id: 'finished', label: '最近完成', description: '已检测到本轮结束事件',
      emptyLabel: '近期没有已结束的会话', sessions: finished },
  ];
}


const RECENT_COMPLETION_MS = 24 * 60 * 60 * 1000;

/** The compact dock only shows user-facing completed turns, never subagent finishes.
 * Source-relative age also prevents remote clock skew from hiding recent completions. */
export function recentParentCompletions(rows: SessionRecord[], now: number, scannedAt?: number): SessionRecord[] {
  return rows.filter(row => {
    if (row.status !== 'finished' || row.isSubagent === true) return false;
    const age = typeof row.ageAtSourceMs === 'number' && Number.isFinite(row.ageAtSourceMs) &&
      scannedAt != null ? row.ageAtSourceMs + Math.max(0, now - scannedAt) :
      now - row.updatedAt;
    return age >= -10_000 && age <= RECENT_COMPLETION_MS;
  });
}
