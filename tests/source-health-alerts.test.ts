import { describe, expect, it } from 'vitest';
import { SourceHealthTracker, SOURCE_FAILURE_GRACE_MS } from '../src/shared/source-health-alerts';
import { isSourceAlertKind, sourceAlertKey, sourceIdFromAlertKey } from '../src/shared/source-alert';
import type { SourceResult } from '../src/shared/types';

const NOW = 1_800_000_000_000;
const healthy = (): SourceResult => ({
  id: 'ssh:box', label: 'Server', kind: 'ssh', sessions: [], error: null,
});
const failed = (): SourceResult => ({
  ...healthy(), error: 'PRIVATE_CONNECTION_ERROR',
});

describe('debounced source outage and recovery', () => {
  it('does not notify on first startup error, a short failure or watcher fallback with healthy reads', () => {
    const tracker = new SourceHealthTracker();
    expect(tracker.observe(failed(), NOW)).toEqual([]);
    expect(tracker.observe(failed(), NOW + SOURCE_FAILURE_GRACE_MS - 1)).toEqual([]);
    expect(tracker.observe(healthy(), NOW + SOURCE_FAILURE_GRACE_MS)).toEqual([]);
    expect(tracker.observe(failed(), NOW + 40_000)).toEqual([]);
    expect(tracker.observe(healthy(), NOW + 41_000)).toEqual([]);
  });

  it('notifies a sustained outage once, then recovery once, and another outage as a new episode', () => {
    const tracker = new SourceHealthTracker();
    tracker.observe(healthy(), NOW);
    tracker.observe(failed(), NOW + 1_000);
    tracker.observe(failed(), NOW + 12_000);
    expect(tracker.observe(failed(), NOW + 31_000).map(a=>a.kind))
      .toEqual(['source-offline']);
    expect(tracker.observe(failed(), NOW + 120_000)).toEqual([]);
    const recovery = tracker.observe(healthy(), NOW + 121_000);
    expect(recovery.map(a=>a.kind)).toEqual(['source-recovered']);
    expect(tracker.observe(healthy(), NOW + 122_000)).toEqual([]);
    tracker.observe(failed(), NOW + 130_000);
    const next = tracker.observe(failed(), NOW + 161_000);
    expect(next.map(a=>a.kind)).toEqual(['source-offline']);
    expect(next[0]?.id).not.toBe(recovery[0]?.id);
  });

  it('restores a notified outage without duplicate alerts, but still detects recovery', () => {
    const tracker = new SourceHealthTracker();
    tracker.observe(failed(), NOW);
    tracker.observe(failed(), NOW + 31_000);
    const restored = new SourceHealthTracker();
    restored.restore(tracker.snapshot());
    expect(restored.observe(failed(), NOW + 60_000)).toEqual([]);
    expect(restored.observe(healthy(), NOW + 61_000).map(a=>a.kind))
      .toEqual(['source-recovered']);
    expect(restored.forgetAbsent(new Set())).toBe(true);
    expect(restored.snapshot()).toEqual([]);
    expect(restored.observe(healthy(), NOW + 62_000)).toEqual([]);
  });

  it('retains only a synthetic source navigation key, not an arbitrary session', () => {
    const tracker = new SourceHealthTracker();
    tracker.observe(failed(), NOW);
    const item = tracker.observe(failed(), NOW + 31_000)[0]!;
    expect(item.sessionKey).toBe(sourceAlertKey('ssh:box'));
    expect(item.sessionId).toBe('ssh:box');
    expect(sourceIdFromAlertKey(item.sessionKey)).toBe('ssh:box');
    expect(sourceIdFromAlertKey('ssh:box:one')).toBeNull();
    expect(isSourceAlertKind(item.kind)).toBe(true);
    expect(JSON.stringify(item)).not.toContain('PRIVATE_CONNECTION_ERROR');
  });
});
