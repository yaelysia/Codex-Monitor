import { describe, expect, it } from 'vitest';
import { visibleAlerts, visibleSessions } from '../src/shared/session-visibility';
import type { MonitorAlert, SessionRecord } from '../src/shared/types';

const makeSession = (id: string, isSubagent?: boolean): SessionRecord => ({
  id, key: 'local:' + id, sourceId: 'local', sourceLabel: 'Windows',
  workspace: null, title: id, status: 'working', statusReason: 'test',
  updatedAt: 1000, startedAt: null, isSubagent,
});
const makeAlert = (id: string): MonitorAlert => ({
  id, sessionKey: 'local:' + id, sessionId: id, kind: 'waiting',
  title: id, sourceLabel: 'Windows', workspace: null,
  statusReason: 'waiting', read: false, at: 1000,
});

describe('parent-only default presentation', () => {
  const sessions = [
    makeSession('parent', false),
    makeSession('child', true),
    makeSession('unknown-kind'), // Preserve older log formats without provenance
  ];
  it('hides only confirmed child threads and never mutates collected scan records', () => {
    expect(visibleSessions(sessions).map(s => s.id)).toEqual(['parent', 'unknown-kind']);
    expect(visibleSessions(sessions, false).map(s => s.id)).toEqual(['parent', 'unknown-kind']);
    expect(visibleSessions(sessions, true).map(s => s.id)).toEqual(['parent', 'child', 'unknown-kind']);
    expect(sessions).toHaveLength(3);
  });
  it('filters legacy child alerts out of floating inbox and badge counters', () => {
    const alerts = [makeAlert('parent'), makeAlert('child')];
    expect(visibleAlerts(alerts, sessions).map(a => a.sessionId)).toEqual(['parent']);
    expect(visibleAlerts(alerts, sessions, true)).toHaveLength(2);
    expect(alerts).toHaveLength(2);
  });
  it('must filter alerts against raw sessions, not already hidden UI rows', () => {
    const alerts = [makeAlert('parent'), makeAlert('child')];
    const displayed = visibleSessions(sessions); // child was removed here
    expect(displayed.some(s => s.isSubagent)).toBe(false);
    // Wrong call: no hidden keys remain to suppress the child alert.
    expect(visibleAlerts(alerts, displayed).map(a => a.sessionId))
      .toEqual(['parent', 'child']);
    // Correct call: raw source evidence still contains child identity.
    expect(visibleAlerts(alerts, sessions, false).map(a => a.sessionId))
      .toEqual(['parent']);
  });
});
