import { describe, expect, it } from 'vitest';
import { desktopThreadUrl } from '../src/shared/desktop-navigation';
import type { SessionRecord } from '../src/shared/types';

const session = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
  key: 'local:019a1020-0000-7000-8000-111122223333',
  id: '019a1020-0000-7000-8000-111122223333',
  sourceId: 'local', sourceLabel: 'Windows', workspace: null,
  title: null, status: 'unknown', statusReason: 'test',
  updatedAt: Date.now(), startedAt: null, ...overrides,
});

describe('Codex Desktop official protocol URL', () => {
  it('generates the upstream TUI route only for a validated Desktop-owned UUID', () => {
    expect(desktopThreadUrl(session({ clientKind: 'desktop' })))
      .toBe('codex://threads/019a1020-0000-7000-8000-111122223333');
    expect(desktopThreadUrl(session({
      clientKind: 'terminal', desktopRuntimeObserved: true,
    }))).toBe('codex://threads/019a1020-0000-7000-8000-111122223333');
  });

  it('does not redirect CLI or VS Code threads without Desktop runtime evidence', () => {
    expect(desktopThreadUrl(session({ clientKind: 'terminal' }))).toBeNull();
    expect(desktopThreadUrl(session({ clientKind: 'vscode' }))).toBeNull();
    expect(desktopThreadUrl(session({ clientKind: 'unknown' }))).toBeNull();
  });

  it('rejects untrusted IDs and hidden subagents before constructing a protocol URL', () => {
    expect(desktopThreadUrl(session({ clientKind: 'desktop', isSubagent: true }))).toBeNull();
    expect(desktopThreadUrl(session({
      id: '019a1020-0000-7000-8000-111122223333\\n--malicious',
      clientKind: 'desktop',
    }))).toBeNull();
    expect(desktopThreadUrl(session({
      id: 'abc', clientKind: 'desktop', desktopRuntimeObserved: true,
    }))).toBeNull();
    expect(desktopThreadUrl(null)).toBeNull();
  });
});
