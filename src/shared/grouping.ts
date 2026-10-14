import type { SessionRecord } from './types';

export interface WorkspaceGroup {
  key: string;
  workspace: string | null;
  sessions: SessionRecord[];
  working: number;
  waiting: number;
  latest: number;
}

export interface ExecutionGroup {
  sourceId: string;
  sourceLabel: string;
  workspaces: WorkspaceGroup[];
  count: number;
  working: number;
  waiting: number;
  latest: number;
}

function workspaceKey(sourceId: string, workspace: string | null): string {
  if (!workspace) return '';
  const normalized = workspace.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return sourceId === 'local' ? normalized.toLocaleLowerCase() : normalized;
}

export function workspaceGroupKey(sourceId: string, workspace: string | null): string {
  return sourceId + ':' + workspaceKey(sourceId, workspace);
}

/** Keeps identically named projects on different machines, or in different directories, separate. */
export function groupByExecutionLocation(sessions: SessionRecord[]): ExecutionGroup[] {
  const sources = new Map<string, { group: ExecutionGroup; workspaces: Map<string, WorkspaceGroup> }>();
  for (const session of sessions) {
    let source = sources.get(session.sourceId);
    if (!source) {
      source = {
        group: { sourceId: session.sourceId, sourceLabel: session.sourceLabel, workspaces: [], count: 0,
          working: 0, waiting: 0, latest: 0 },
        workspaces: new Map(),
      };
      sources.set(session.sourceId, source);
    }
    const key = workspaceKey(session.sourceId, session.workspace);
    let workspace = source.workspaces.get(key);
    if (!workspace) {
      workspace = { key: `${session.sourceId}:${key}`, workspace: session.workspace,
        sessions: [], working: 0, waiting: 0, latest: 0 };
      source.workspaces.set(key, workspace);
    }
    workspace.sessions.push(session);
    workspace.working += Number(session.status === 'working');
    workspace.waiting += Number(session.status === 'waiting');
    workspace.latest = Math.max(workspace.latest, session.updatedAt);
    source.group.count++;
    source.group.working += Number(session.status === 'working');
    source.group.waiting += Number(session.status === 'waiting');
    source.group.latest = Math.max(source.group.latest, session.updatedAt);
  }
  const groups = Array.from(sources.values(), ({ group, workspaces }) => {
    group.workspaces = Array.from(workspaces.values()).map(workspace => {
      workspace.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return workspace;
    }).sort((a, b) => (b.working + b.waiting) - (a.working + a.waiting) || b.latest - a.latest);
    return group;
  });
  return groups.sort((a, b) => (b.working + b.waiting) - (a.working + a.waiting) || b.latest - a.latest);
}
