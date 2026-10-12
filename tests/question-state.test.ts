import { describe, expect, it } from 'vitest';
import { detectPendingQuestion } from '../src/shared/question-state';
const row = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
const text = (...records: string[]) => records.join('\n') + '\n';
const ask = (call_id: string, name = 'request_user_input') => row('response_item', {
  type: 'function_call', name, call_id,
  arguments: JSON.stringify({ questions: [{ id: 'confirm', header: '继续吗', question: '现在继续部署吗？' }] }),
});
const answer = (id: string) => row('response_item', { type: 'function_call_output', call_id: id, output: '{}' });

describe('Codex durable question evidence', () => {
  it('recognizes a blocking request_user_input call before an answer arrives', () => {
    expect(detectPendingQuestion(text(
      row('event_msg', { type: 'task_started' }),
      ask('call-1'),
    ))).toEqual({ token: 'blocking:call-1', blocking: true, text: '现在继续部署吗？' });
  });
  it('matches the answer to the correct call ID and clears waiting', () => {
    const pending = text(ask('one'), ask('two'), answer('one'));
    expect(detectPendingQuestion(pending).token).toBe('blocking:two');
    expect(detectPendingQuestion(pending + answer('two') + '\n').token).toBeNull();
  });
  it('does not mark finished or aborted turns as waiting on stale calls', () => {
    expect(detectPendingQuestion(text(ask('one'), row('event_msg', { type: 'turn_complete' }))).token).toBeNull();
    expect(detectPendingQuestion(text(ask('one'), row('event_msg', { type: 'turn_aborted' }))).token).toBeNull();
    expect(detectPendingQuestion(text(ask('one'), row('event_msg', { type: 'turn_started' }))).token).toBeNull();
  });
  it('recognizes persisted async questions despite immediate accepted tool output', () => {
    const pending = text(
      row('response_item', { type: 'function_call', name: 'request_user_input_async', call_id: 'a1',
        arguments: '{"questions":[{"title":"哪个环境？"}]}' }),
      row('event_msg', { type: 'item_completed', item: { type: 'AgentMessage', id: 'a1',
        delivery: 'async', questions: [{ title: '哪个环境？', options: ['开发', '生产'] }] } }),
      answer('a1'),
      row('event_msg', { type: 'turn_complete' }),
    );
    expect(detectPendingQuestion(pending)).toEqual({ token: 'async:a1', blocking: false, text: '哪个环境？' });
    expect(detectPendingQuestion(pending +
      row('event_msg', { type: 'user_message', message: '开发' }) + '\n').token).toBeNull();
  });
  it('ignores ordinary assistant messages, tool invocations, and false pending async calls', () => {
    expect(detectPendingQuestion(text(
      row('response_item', { type: 'function_call', name: 'exec_command', call_id: 'cmd',
        arguments: '{"cmd":"echo request_user_input"}' }),
      row('event_msg', { type: 'item_completed', item: { type: 'AgentMessage',
        delivery: 'async', questions: [] } }),
      row('response_item', { type: 'function_call', name: 'request_user_input_async',
        call_id: 'accepted-without-message' }),
    )).token).toBeNull();
  });
  it('recovers from malformed clipped JSONL lines and refuses stale tool names in user text', () => {
    const data = 'broken-start\n' + ask('answer-1') + '\n{"partial"';
    expect(detectPendingQuestion(data, true).token).toBe('blocking:answer-1');
    expect(detectPendingQuestion(text(row('event_msg', {
      type: 'user_message', message: 'I am waiting for request_user_input' }))).token).toBeNull();
  });
  it('accepts a namespaced request_permissions tool as pending human action', () => {
    expect(detectPendingQuestion(text(ask('permission', 'functions.request_permissions')))
      .toMatchObject({ token: 'blocking:permission', blocking: true });
  });
});
