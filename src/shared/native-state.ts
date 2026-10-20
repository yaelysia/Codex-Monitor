import type { ScanResponse, SessionRecord, SourceResult } from './types';

export type NativeState = 'active' | 'idle' | 'systemError' | 'notLoaded' | 'unknown';
export type NativeFlag = 'waitingOnUserInput' | 'waitingOnApproval';
export interface NativeStatus { state: NativeState; flags: NativeFlag[] }
export interface NativeSample extends NativeStatus {
  key: string; sourceId: string; at: number; isSubagent: boolean;
}
export interface NativeConnection {
  sourceId: string; enabled: boolean; transport: 'auto' | 'socket' | 'ws'; endpoint: string;
}
/** Internal connection identity; contains endpoint, NEVER include in diagnostic exports. */
export const nativeConnectionKey = (row: NativeConnection): string =>
  JSON.stringify([row.sourceId, row.transport, row.endpoint]);
export type NativeHealthState = 'disabled' | 'connecting' | 'connected' | 'degraded';
export type NativeHealthReason = 'disabled' | 'source-unavailable' | 'connecting' |
  'no-matching-threads' | 'metadata-only' | 'partial-coverage' | 'connection-unavailable' |
  'request-failed' | 'protocol-unsupported' | 'stale';
export interface NativeHealth {
  sourceId: string; transport: NativeConnection['transport']; state: NativeHealthState;
  reason: NativeHealthReason; loaded: number; matched: number; covered: number;
  listComplete: boolean; lastSuccessAt: number | null; retries: number; ignoredRequests: number;
  /** Cumulative metadata reads and matched passive hint events (no message bodies). */
  readRequests?: number; passiveHints?: number;
}
/** Local-only coverage explanation. Never export sessionKey in a diagnostic report. */
export type NativeCoverageReason = 'covered' | 'source-unavailable' | 'subagent' |
  'invalid-thread-id' | 'not-configured' | 'endpoint-unavailable' | 'not-loaded' |
  'list-incomplete' | 'pending-verification' | 'sample-expired' |
  'file-newer-than-native' | 'status-unrecognized';
export interface NativeCoverageEntry {
  sourceId: string; sessionKey: string; reason: NativeCoverageReason;
}
export const NATIVE_SAMPLE_TTL_MS = 15_000;
export const MAX_NATIVE_CONNECTIONS = 8;
export const THREAD_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** Unknown active flags cannot justify a positive running claim. */
export function parseNativeThread(value: unknown, id: string):
  (NativeStatus & { isSubagent: boolean }) | null {
  const row = object(value), status = object(row?.status);
  if (!row || row.id !== id || !status ||
      !['active', 'idle', 'systemError', 'notLoaded'].includes(String(status.type))) return null;
  const source = object(row.source);
  const isSubagent = (typeof row.parentThreadId === 'string' && !!row.parentThreadId) ||
    !!source && (Object.hasOwn(source, 'subAgent') || Object.hasOwn(source, 'subagent'));
  if (status.type !== 'active') return { state: status.type as NativeState, flags: [], isSubagent };
  if (!Array.isArray(status.activeFlags) || status.activeFlags.some(flag =>
      flag !== 'waitingOnUserInput' && flag !== 'waitingOnApproval')) return null;
  return { state: 'active', flags: [...new Set(status.activeFlags)].sort() as NativeFlag[], isSubagent };
}
export function isNativeWaiting(status: NativeStatus): boolean {
  return status.state === 'active' && status.flags.length > 0;
}
export function freshNative(sample: NativeSample, now: number): boolean {
  return now >= sample.at && now - sample.at <= NATIVE_SAMPLE_TTL_MS;
}
/** Compare against a host-clock file observation, never an unadjusted SSH timestamp. */
export function nativeFileChangedAt(source: SourceResult, row: SessionRecord): number | null {
  return Number.isFinite(row.ageAtSourceMs) && source.capturedAt != null
    ? source.capturedAt - Math.max(0, row.ageAtSourceMs!)
    : source.kind === 'local' ? row.updatedAt : source.capturedAt ?? null;
}

/** Identity is source + thread. Never fuse identical UUIDs across machines. */
export function projectNativeScan(scan: ScanResponse | null,
  samples: ReadonlyMap<string, NativeSample>, now = Date.now()): ScanResponse | null {
  if (!scan || !samples.size) return scan;
  let changed = false;
  const sources = scan.sources.map(source => {
    if (source.error || source.stale) return source;
    let sourceChanged = false;
    const sessions = source.sessions.map(row => {
      const sample = samples.get(row.key);
      if (!sample || sample.sourceId !== source.id || sample.isSubagent || row.isSubagent ||
          !freshNative(sample, now) || sample.state === 'notLoaded' || sample.state === 'unknown') return row;
      // A file update after the read started wins until another native read.
      const changedAt = nativeFileChangedAt(source, row);
      if (changedAt != null && changedAt > sample.at) return row;
      const terminal = row.status === 'finished' || row.status === 'failed' || row.status === 'interrupted';
      const pending = isNativeWaiting(sample);
      const status = sample.state === 'active' ? pending ? 'waiting' :
        row.pendingQuestionToken ? row.status : 'working'
        : sample.state === 'idle' && terminal ? row.status : 'unknown';
      const reason = sample.state === 'active'
        ? pending ? 'App Server 原生确认：等待用户输入或审批（只读，不代答）'
          : row.pendingQuestionToken ? row.statusReason + '；App Server 当前活跃，保留已落盘异步待回答提示'
          : 'App Server 原生确认：线程当前活跃'
        : sample.state === 'idle' ? terminal ? row.statusReason + '；App Server 当前空闲'
          : 'App Server 原生确认当前空闲；没有本轮成功结束证据，不能认定任务完成'
        : 'App Server 报告 systemError；不等同于已确认某一轮执行失败';
      sourceChanged = changed = true;
      return { ...row, status, statusReason: reason,
        nativeStatus: { state: sample.state, flags: [...sample.flags] } } as SessionRecord;
    });
    return sourceChanged ? { ...source, sessions } : source;
  });
  return changed ? { ...scan, sources } : scan;
}
