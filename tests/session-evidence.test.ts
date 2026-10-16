import { describe, expect, it } from 'vitest';
import { sessionEvidenceLabel } from '../src/shared/session-evidence';
import { applyDesktopLogEvidence } from '../src/shared/desktop-log-status';
import { SessionActivityTracker } from '../src/shared/activity-tracker';
import type { SessionRecord } from '../src/shared/types';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const ID = '019a21b0-aaaa-7ccc-8ddd-111122223333';
const make = (status: SessionRecord['status']): SessionRecord => ({
  id: ID, key: 'local:' + ID, sourceId: 'local', sourceLabel: 'Windows',
  workspace: null, title: 'Example', updatedAt: NOW, startedAt: null,
  status, statusReason: 'raw',
});
describe('provenance distinct from tentative activity', () => {
  it('keeps historical Desktop starts as unknown while recent ones stay tentative', () => {
    const recent = make('unknown');
    const old = make('unknown');
    applyDesktopLogEvidence([recent], new Map([[ID, {
      threadId: ID, at: NOW - 1000, type: 'turn-start-accepted',
    }]]), NOW);
    applyDesktopLogEvidence([old], new Map([[ID, {
      threadId: ID, at: NOW - 20 * 60 * 60_000, type: 'turn-start-accepted',
    }]]), NOW);
    expect(recent).toMatchObject({ status: 'working', evidenceKind: 'recent-start' });
    expect(old).toMatchObject({ status: 'unknown', statusReason: 'raw' });
    expect(old.evidenceKind).toBeUndefined();
    expect(sessionEvidenceLabel(old)).toContain('未确认');
  });
  it('treats source activity and retained silence separately', () => {
    const tracker = new SessionActivityTracker();
    const sources = (row: SessionRecord) => [{
      id: 'local', label: 'Windows', kind: 'local' as const, error: null, sessions: [row],
    }];
    const initial = make('working');
    tracker.annotate(sources(initial), NOW);
    expect(initial.evidenceKind).toBe('recent-activity');
    const silent = make('unknown');
    tracker.annotate(sources(silent), NOW + 2 * 60_000);
    expect(silent.evidenceKind).toBe('retained-activity');
    expect(sessionEvidenceLabel(silent)).toContain('静默期');
  });
  it('makes terminal and unknown states override historical provenance', () => {
    expect(sessionEvidenceLabel({status: 'finished', evidenceKind: 'historical-start'})).toContain('结束事件');
    expect(sessionEvidenceLabel({status: 'unknown'})).toContain('未确认');
  });
});
