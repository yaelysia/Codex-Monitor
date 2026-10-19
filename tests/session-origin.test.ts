import { describe, expect, it } from 'vitest';
import { classifySessionOrigin, extractSessionOrigin,
  classifyClientKind, extractSessionClientKind } from '../src/shared/session-origin';

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

  it('recognizes native Codex Desktop originator rather than dropping it as unknown', () => {
    expect(extractSessionOrigin(meta({ id: PARENT, originator: 'codex_desktop' })).isSubagent)
      .toBe(false);
  });

  it('does not mark regular forks as subagents', () => {
    const fork = meta({ id: CHILD, session_id: CHILD, source: 'vscode', forked_from_id: PARENT });
    expect(extractSessionOrigin(fork).isSubagent).toBe(false);
  });
});

describe('canonical Codex session source used only when originator is unavailable',()=>{
  it('identifies VS Code and CLI from explicit canonical source, without guessing process by cwd',()=>{
    expect(extractSessionClientKind(meta({id:PARENT,source:'vscode',originator:null})))
      .toBe('vscode');
    expect(extractSessionClientKind(meta({id:PARENT,source:'cli'}))).toBe('terminal');
    expect(classifyClientKind('codex_desktop','vscode')).toBe('desktop');
    expect(classifyClientKind('codex_cli_rs','vscode')).toBe('terminal');
    expect(classifyClientKind(null,{subagent:'review'})).toBe('unknown');
    expect(classifyClientKind(null,'exec')).toBe('unknown');
    expect(classifyClientKind(null,'appServer')).toBe('unknown');
  });

  it('safely handles an oversized session_meta while extracting source before base_instructions',()=>{
    const head=meta({id:PARENT,source:'vscode',base_instructions:'PRIVATE_PROMPT'.repeat(20_000)})
      .slice(0,128*1024);
    expect(extractSessionClientKind(head)).toBe('vscode');
    expect(extractSessionClientKind(meta({
      id:PARENT,base_instructions:'{ "source": "vscode" }',
    }).slice(0,128*1024))).toBe('unknown');
  });
});
