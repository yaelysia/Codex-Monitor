import { describe, expect, it } from 'vitest';
import { projectDesktopRuntime, recentDesktopCompletions } from '../electron/collector';
import { DesktopLogEventCache, type DesktopLogEvent } from '../src/shared/desktop-log-status';
import type { DesktopLogSummary } from '../electron/desktop-runtime-logs';
import type { ScanResponse, SessionRecord } from '../src/shared/types';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const ID = '019a21b0-aaaa-7ccc-8ddd-111122223333';
const TURN = '019a21b0-aaaa-7ccc-8ddd-999922223333';
const thread = (props: Partial<SessionRecord> = {}): SessionRecord => ({
  id: ID, key: 'ssh:remote:' + ID, sourceId: 'ssh:remote',
  sourceLabel: 'Remote', workspace: null,
  title: null, status: 'unknown', statusReason: 'original rollout',
  clientKind: 'terminal', updatedAt: NOW - 90_000,
  ageAtSourceMs: 90_000, startedAt: null,
  ...props,
});
const snapshot = (session: SessionRecord): ScanResponse => ({
  scannedAt: NOW - 1000,
  sources: [{
    id: session.sourceId, label: session.sourceLabel, kind: 'ssh',
    error: null, capturedAt: NOW - 1000, sessions: [session],
  }],
});
const event = (type: DesktopLogEvent['type'], at: number): DesktopLogEvent => ({
  threadId: ID, type, at,
  ...(type === 'turn-displayed-complete' ? { turnId: TURN } : {}),
});
const inspect = (nativeEvent: DesktopLogEvent | null) =>
  async (): Promise<DesktopLogSummary> => ({
    events: nativeEvent ? new Map([[nativeEvent.threadId, nativeEvent]]) : new Map(),
    logFilesRead: 1,
    signalCount: nativeEvent ? 1 : 0,
    discovery: {
      validLocalAppData: true, rootCount: 1, existingRootCount: 1,
      readableDayFolders: 1, matchingLogNames: 1, recentCandidateCount: 1,
    },
  });

describe('end-to-end Desktop runtime evidence projection', () => {
  it('sets execution to working from a matched GUI start independent of CLI origin', async () => {
    const original = thread();
    const raw = snapshot(original);
    const working = await projectDesktopRuntime(raw, NOW, {
      platform: 'win32', cache: new DesktopLogEventCache(),
      inspect: inspect(event('turn-start-accepted', NOW - 5000)),
    });
    expect(working.sources[0]!.sessions[0]).toMatchObject({
      status: 'working', desktopRuntimeObserved: true,
    });
    // Never pollute raw filesystem state: native overlays can be retracted.
    expect(raw.sources[0]!.sessions[0]).toMatchObject({
      status: 'unknown', statusReason: 'original rollout',
    });
    expect(raw.sources[0]!.sessions[0]!.desktopRuntimeObserved).toBeUndefined();
  });

  it('recovers GUI activity when a previous file completion lacks a timestamp', async () => {
    const original = thread({
      status: 'finished', finishedToken: '|previous-terminal',
      ageAtSourceMs: 60_000,
    });
    const state = await projectDesktopRuntime(snapshot(original), NOW, {
      platform: 'win32', cache: new DesktopLogEventCache(),
      inspect: inspect(event('turn-start-accepted', NOW - 5000)),
    });
    expect(state.sources[0]!.sessions[0]).toMatchObject({
      status: 'working', finishedToken: null, desktopRuntimeObserved: true,
    });
  });

  it('does not resurrect a task when the source file has a newer completion', async () => {
    const previous = thread({
      status: 'finished', finishedToken: '|current-terminal',
      ageAtSourceMs: 500,
    });
    const state = await projectDesktopRuntime(snapshot(previous), NOW, {
      platform: 'win32', cache: new DesktopLogEventCache(),
      inspect: inspect(event('turn-start-accepted', NOW - 5000)),
    });
    expect(state.sources[0]!.sessions[0]!.status).toBe('finished');
    expect(state.sources[0]!.sessions[0]!.desktopRuntimeObserved).toBeUndefined();
  });

  it('does not interpret historical Desktop completion as currently running client', async () => {
    const original = snapshot(thread({ status: 'unknown' }));
    const cache = new DesktopLogEventCache();
    await projectDesktopRuntime(original, NOW, {
      platform: 'win32', cache,
      inspect: inspect(event('turn-start-accepted', NOW - 10_000)),
    });
    const completed = await projectDesktopRuntime(original, NOW + 3000, {
      platform: 'win32', cache,
      inspect: inspect(event('turn-displayed-complete', NOW - 1000)),
    });
    expect(completed.sources[0]!.sessions[0]!.status).toBe('unknown');
    expect(completed.sources[0]!.sessions[0]!.desktopRuntimeObserved).toBeUndefined();
  });

  it('can recover an active GUI start after monitor restart and no matching log tail', async () => {
    const cache = new DesktopLogEventCache();
    cache.restore([event('turn-start-accepted', NOW - 8000)], NOW);
    const state = await projectDesktopRuntime(snapshot(thread()), NOW + 1000, {
      platform: 'win32', cache, inspect: inspect(null),
    });
    expect(state.sources[0]!.sessions[0]).toMatchObject({
      status: 'working', desktopRuntimeObserved: true,
    });
  });

  it('recovers a 20-hour GUI turn while labeling stale status as unverified', async () => {
    const longStart = event('turn-start-accepted', NOW - 20 * 60 * 60_000);
    const raw = snapshot(thread({ status: 'unknown', ageAtSourceMs: 20 * 60 * 60_000 }));
    const cache = new DesktopLogEventCache();
    cache.restore([longStart], NOW);
    const result = await projectDesktopRuntime(raw, NOW, {
      platform: 'win32', cache, inspect: inspect(null),
    });
    const row = result.sources[0]!.sessions[0]!;
    expect(row.status).toBe('working');
    expect(row.statusReason).toContain('未实时确认');
    expect(row.desktopRuntimeObserved).toBeUndefined();
    expect(raw.sources[0]!.sessions[0]!.status).toBe('unknown');
  });

  it('never overrides a completed turn with an older persisted Desktop start', async () => {
    const longStart = event('turn-start-accepted', NOW - 20 * 60 * 60_000);
    const raw = snapshot(thread({
      status: 'finished', finishedToken: new Date(NOW - 19 * 60 * 60_000).toISOString() + '|' + TURN,
    }));
    const result = await projectDesktopRuntime(raw, NOW, {
      platform: 'win32', cache: new DesktopLogEventCache(),
      inspect: inspect(longStart),
    });
    expect(result.sources[0]!.sessions[0]!.status).toBe('finished');
    expect(result.sources[0]!.sessions[0]!.desktopRuntimeObserved).toBeUndefined();
  });

  it('keeps a CLI-owned active turn separate from 50-minute-old Desktop provenance', async () => {
    const original = thread({
      status: 'working', clientKind: 'terminal', statusReason: 'CLI rollout turn-started',
    });
    // The cache keeps 72h of ordering history, but GUI ownership
    // expires after 45m even when the filesystem already says "working".
    const oldStart = event('turn-start-accepted', NOW - 50 * 60_000);
    const state = await projectDesktopRuntime(snapshot(original), NOW, {
      platform: 'win32', cache: new DesktopLogEventCache(),
      inspect: inspect(oldStart),
    });
    expect(state.sources[0]!.sessions[0]).toMatchObject({
      status: 'working', statusReason: 'CLI rollout turn-started',
      clientKind: 'terminal',
    });
    expect(state.sources[0]!.sessions[0]!.desktopRuntimeObserved).toBeUndefined();
  });

  it('keeps original working-state evidence but still reports active GUI ownership', async () => {
    const state = await projectDesktopRuntime(snapshot(thread({
      status: 'working', statusReason: 'rollout turn-started',
    })), NOW, {
      platform: 'win32', cache: new DesktopLogEventCache(),
      inspect: inspect(event('turn-start-accepted', NOW - 5000)),
    });
    expect(state.sources[0]!.sessions[0]).toMatchObject({
      status: 'working', statusReason: 'rollout turn-started',
      desktopRuntimeObserved: true,
    });
  });
});

// Regression: a Desktop completion followed quickly by another accepted
// turn/start is still retained for an independent completion notification.
describe('native completion signal queue', () => {
  it('retains a completed turn after a later start in the same thread', async () => {
    const early = event('turn-displayed-complete', NOW - 4000);
    const later = event('turn-start-accepted', NOW - 1000);
    const inspected = async (): Promise<DesktopLogSummary> => ({
      events: new Map([[ID, later]]), completions: [early],
      logFilesRead: 1, signalCount: 2,
      discovery: { validLocalAppData: true, rootCount: 1,
        existingRootCount: 1, readableDayFolders: 1, matchingLogNames: 1,
        recentCandidateCount: 1 },
    });
    await projectDesktopRuntime(snapshot(thread()), NOW, {
      platform: 'win32', inspect: inspected,
    });
    expect(recentDesktopCompletions(NOW).some(x => x.threadId === ID &&
      x.turnId === TURN && x.type === 'turn-displayed-complete')).toBe(true);
  });
});
