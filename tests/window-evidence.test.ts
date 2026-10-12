import { describe, expect, it } from 'vitest';
import { classifyClientKind, extractSessionClientKind } from '../src/shared/session-origin';
import { extractLastUserInputAt } from '../electron/rollout';

describe('read-only client/window evidence from Codex rollouts', () => {
  it('uses originator, never infers vscode from source alone', () => {
    expect(classifyClientKind('Codex Desktop')).toBe('desktop');
    expect(classifyClientKind('codex_desktop')).toBe('desktop');
    expect(classifyClientKind('codex_vscode')).toBe('vscode');
    expect(classifyClientKind('codex-tui')).toBe('terminal');
    expect(classifyClientKind('custom app')).toBe('unknown');
    expect(extractSessionClientKind(JSON.stringify({ type: 'session_meta',
      payload: { source: 'vscode' } }))).toBe('unknown');
  });
  it('works with clipped oversized session_meta and ignores transcript text', () => {
    const data = JSON.stringify({ type: 'session_meta',
      payload: { id: 't', originator: 'codex_cli_rs', base_instructions: 'PRIVATE'.repeat(40000) } });
    expect(extractSessionClientKind(data.slice(0, 128 * 1024))).toBe('terminal');
    expect(extractSessionClientKind(JSON.stringify({ type: 'event_msg',
      payload: { type: 'user_message', message: 'codex_vscode' } }))).toBe('unknown');
  });
  it('records only actual user input timestamps, not messages', () => {
    const events = [
      { type: 'event_msg', timestamp: '2026-10-12T08:01:00Z',
        payload: { type: 'user_message', message: 'PRIVATE QUERY' } },
      { type: 'event_msg', timestamp: '2026-10-12T08:02:00Z',
        payload: { type: 'agent_message', message: 'not user' } },
      { type: 'event_msg', timestamp: '2026-10-12T08:03:00Z',
        payload: { type: 'user_message', message: 'another private query' } },
    ];
    expect(extractLastUserInputAt(events.map(x => JSON.stringify(x)).join('\n')))
      .toBe(Date.parse('2026-10-12T08:03:00Z'));
    expect(extractLastUserInputAt('clipped\n' + JSON.stringify(events[2]), true))
      .toBe(Date.parse('2026-10-12T08:03:00Z'));
    expect(extractLastUserInputAt('garbled')).toBeNull();
    const item = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-12T09:10:00Z',
      payload: { type: 'item_completed', item: { type: 'UserMessage',
        content: [{ type: 'Text', text: 'PRIVATE' }] } } });
    const raw = JSON.stringify({ type: 'response_item', timestamp: '2026-10-12T09:11:00Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET' }] } });
    expect(extractLastUserInputAt([item, raw].join('\n')))
      .toBe(Date.parse('2026-10-12T09:11:00Z'));
  });
});
