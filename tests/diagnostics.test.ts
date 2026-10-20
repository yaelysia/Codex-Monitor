import { describe, expect, it } from 'vitest';
import { DiagnosticRecorder, DIAGNOSTIC_EVENT_LIMIT } from '../src/shared/diagnostics';
import type { MonitorState } from '../src/shared/types';
import type { NativeHealth } from '../src/shared/native-state';
const NOW = 1_800_000_000_000;
function state(): MonitorState {
  return { muted: false, eventChannels: { 'ssh:SECRET_HOST': 'active' }, alerts: [], scan: {
    scannedAt: NOW, sources: [{ id: 'ssh:SECRET_HOST', kind: 'ssh', label: 'SECRET_HOST',
      error: null, capturedAt: NOW, sessions: [{ id: 'SECRET_UUID', key: 'ssh:SECRET_HOST:SECRET_UUID',
        sourceId: 'ssh:SECRET_HOST', sourceLabel: 'SECRET_HOST', status: 'working',
        title: 'SECRET_TITLE', workspace: '/SECRET_PATH', questionText: 'SECRET_PROMPT',
        statusReason: 'SECRET_ERROR', updatedAt: NOW, startedAt: null }] }],
  } };
}
const health: NativeHealth = { sourceId: 'ssh:SECRET_HOST', transport: 'ws', state: 'connected',
  reason: 'metadata-only', loaded: 3, matched: 1, covered: 1, listComplete: true,
  lastSuccessAt: NOW, retries: 0, ignoredRequests: 1 };

describe('bounded privacy-safe diagnostic recorder', () => {
  it('exports whitelisted counters and anonymous identities, never labels or payloads', () => {
    const recorder = new DiagnosticRecorder(), input = state();
    input.scan!.sources[0]!.scanMetrics = { durationMs: 4, sessionCount: 1, statCalls: 8, cacheHits: 2 };
    recorder.observe(input, NOW);
    recorder.recordPopup(input.scan!.sources[0]!.sessions[0]!.key, false, input, NOW + 1);
    const view = recorder.snapshot(input, [health], NOW + 2);
    expect(JSON.stringify(view.report)).not.toContain('SECRET');
    expect(view.report.sources[0]).toMatchObject({ durationMs: 4, statCalls: 8, cacheHits: 2, channel: 'active' });
    expect(view.sessions[0]!.title).toBe('SECRET_TITLE');
    expect(view.report.events.at(-1)?.kind).toBe('popup-requested');
    expect(view.report.events.at(-1)?.session).toBe(view.sessions[0]!.ref);
  });
  it('summarizes per-thread coverage anonymously and carries read diagnostics through to export', () => {
    const recorder = new DiagnosticRecorder(), input = state();
    const h = { ...health, readRequests: 18, passiveHints: 2 };
    const row = input.scan!.sources[0]!.sessions[0]!;
    const result = recorder.snapshot(input, [h], NOW, [
      { sourceId: 'ssh:SECRET_HOST', sessionKey: row.key, reason: 'not-loaded' },
    ]);
    expect(result.report.native[0]).toMatchObject({ readRequests: 18, passiveHints: 2 });
    expect(result.report.coverage).toMatchObject([{ source: 'S1', reason: 'not-loaded', count: 1 }]);
    expect(result.coverage[0]?.ref).toBe(result.sessions[0]?.ref);
    expect(JSON.stringify(result.report)).not.toContain('SECRET');
    expect(JSON.stringify(result.coverage)).not.toContain('SECRET');
  });
  it('records actual transitions only; returned objects cannot mutate the recorder', () => {
    const recorder = new DiagnosticRecorder(), input = state();
    recorder.observe(input, NOW); const first = recorder.snapshot(input, [], NOW).report.events.length;
    for (let i = 0; i < 100; i++) recorder.observe(input, NOW + i);
    expect(recorder.snapshot(input, [], NOW).report.events).toHaveLength(first);
    input.scan!.sources[0]!.sessions[0]!.status = 'waiting';
    recorder.observe(input, NOW + 200);
    const view = recorder.snapshot(input, [], NOW + 200);
    expect(view.report.events.at(-1)).toMatchObject({ kind: 'session', status: 'waiting', pending: true });
    view.report.events[0]!.source = 'tampered';
    expect(recorder.snapshot(input, [], NOW).report.events[0]!.source).not.toBe('tampered');
  });
  it('records read/suppressed decisions and never reports an actual OS display', () => {
    const recorder = new DiagnosticRecorder(), input = state();
    const row = input.scan!.sources[0]!.sessions[0]!;
    input.alerts = [{ id: 'SECRET_ALERT', sessionKey: row.key, sessionId: row.id, kind: 'waiting',
      title: 'SECRET_TITLE', sourceLabel: 'SECRET_HOST', workspace: '/SECRET_PATH',
      statusReason: 'SECRET_PROMPT', at: NOW, read: false }];
    recorder.observe(input, NOW);
    input.alerts[0]!.read = true; recorder.observe(input, NOW + 1);
    recorder.recordPopup(row.key, true, input, NOW + 2);
    const report = recorder.snapshot(input, [], NOW + 3).report;
    expect(report.events.slice(-2).map(row => row.kind)).toEqual(['read', 'popup-suppressed']);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it('bounds long-running history and clears diagnostics without changing the inbox', () => {
    const recorder = new DiagnosticRecorder(), input = state();
    for (let i = 0; i < 1000; i++) {
      input.scan!.sources[0]!.sessions[0]!.status = i % 2 ? 'working' : 'unknown';
      recorder.observe(input, NOW + i);
    }
    const result = recorder.snapshot(input, [], NOW + 1000);
    expect(result.report.events).toHaveLength(DIAGNOSTIC_EVENT_LIMIT);
    expect(result.report.dropped).toBeGreaterThan(0);
    const before = JSON.stringify(input);
    recorder.clear();
    expect(recorder.snapshot(input, [], NOW).report.events).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });
});
