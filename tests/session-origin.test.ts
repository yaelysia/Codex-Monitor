import { describe, expect, it } from 'vitest';
import { classifySessionOrigin, extractSessionOrigin } from '../src/shared/session-origin';

const PARENT = '00000000-0000-4000-8000-000000000001';
const CHILD = '00000000-0000-4000-8000-000000000002';
const meta = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: '2026-10-12T08:00:00Z', type: 'session_meta', payload });

describe('Codex session origin', () => {
  it('identifies Codex thread-spawn and nested child sessions with parent id', () => {
    const child = { id: CHILD, session_id: PARENT, source: {
      subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } },
    }, thread_source: 'subagent', parent_thread_id: PARENT };
    expect(classifySessionOrigin(child)).toEqual({ isSubagent: true, parentThreadId: PARENT });
    expect(extractSessionOrigin(meta(child))).toEqual({ isSubagent: true, parentThreadId: PARENT });
  });

  it.each([
    { source: { subagent: 'review' } },
    { source: { subagent: 'compact' } },
    { source: { subagent: { other: 'guardian' } } },
    { source: { subAgent: { thread_spawn: { parent_thread_id: PARENT } } } },
    { source: 'subagent' },
    { thread_source: 'subagent' },
    { parent_thread_id: PARENT },
    { session_id: PARENT, id: CHILD },
  ])('recognizes distinct child provenance variants: %j', input => {
    expect(classifySessionOrigin(input).isSubagent).toBe(true);
  });

  it.each([
    { id: PARENT, session_id: PARENT, source: 'cli' },
    { id: PARENT, session_id: PARENT, source: 'vscode', thread_source: 'user' },
    { source: { internal: 'guardian' } },
    { source: 'exec', forked_from_id: PARENT },
    { source: 'unknown', thread_source: null, parent_thread_id: null },
  ])('does not suppress root/user sessions based on unrelated provenance: %j', input => {
    expect(classifySessionOrigin(input)).toEqual({ isSubagent: false, parentThreadId: null });
  });

  it('recovers subagent source from truncated oversized session_meta but not prompt text', () => {
    const prefix = meta({ id: CHILD, source: { subagent: 'review' }, base_instructions: 'x'.repeat(160_000) });
    const head = prefix.slice(0, 128 * 1024);
    expect(extractSessionOrigin(head).isSubagent).toBe(true);
    expect(extractSessionOrigin(meta({
      id: PARENT, source: 'cli',
      base_instructions: 'source: {"subagent": "review"}',
    })).isSubagent).toBe(false);
    expect(extractSessionOrigin(JSON.stringify({
      type: 'event_msg', payload: { type: 'user_message', message: 'subagent thread_spawn' },
    }))).toEqual({ isSubagent: false, parentThreadId: null });
  });

  it('does not mark regular forks as subagents', () => {
    const fork = meta({ id: CHILD, session_id: CHILD, source: 'vscode', forked_from_id: PARENT });
    expect(extractSessionOrigin(fork).isSubagent).toBe(false);
  });
});
