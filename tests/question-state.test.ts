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
  it('recognizes legacy response_item agent_message with structured async questions', () => {
    const question = row('response_item', {
      type:'agent_message', id:'msg-legacy', delivery:'async',
      questions:[{id:'environment',header:'部署环境',question:'应该部署哪个环境？'}],
      content:[{type:'input_text',text:'PRIVATE_OUTPUT_TEXT'}],
    });
    expect(detectPendingQuestion(text(
      row('event_msg',{type:'turn_started'}),question,
      row('event_msg',{type:'turn_complete'}),
    ))).toEqual({token:'async:msg-legacy', blocking:false,
      text:'应该部署哪个环境？'});
    expect(detectPendingQuestion(text(question,
      row('response_item',{type:'message',role:'user',
        content:[{type:'input_text',text:'生产环境'}]})
    )).token).toBeNull();
  });

  it('recovers legacy event_msg.agent_message requests and clears them after a user response', () => {
    const stamp='2026-10-16T02:05:00.000Z';
    const ask=JSON.stringify({ timestamp:stamp,type:'event_msg',
      payload:{type:'agent_message',delivery:'async',
        questions:[{id:'branch',question:'目标分支是哪个？'}],
        message:'PRIVATE_RAW_MESSAGE'} });
    expect(detectPendingQuestion(text(ask))).toEqual({
      token:'async:'+stamp,blocking:false,text:'目标分支是哪个？',
    });
    const reply=row('event_msg',{type:'user_message',message:'main'});
    expect(detectPendingQuestion(text(ask,reply)).token).toBeNull();
  });

  it('recovers a timestamp-identified async question without a message ID', () => {
    const stamp='2026-10-16T02:00:00.000Z';
    const record=JSON.stringify({ timestamp:stamp, type:'response_item',
      payload:{type:'agent_message',delivery:'async',
        questions:[{question:'现在提交吗？'}]} });
    expect(detectPendingQuestion(text(record))).toEqual({
      token:'async:'+stamp,blocking:false,text:'现在提交吗？',
    });
    const notQuestion=row('response_item',{
      type:'agent_message',delivery:'async',questions:[],id:'no-question',
    });
    expect(detectPendingQuestion(text(notQuestion)).token).toBeNull();
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
    expect(detectPendingQuestion(pending +
      row('event_msg', { type: 'item_completed',
        item: { type: 'UserMessage', content: [{ type: 'Text', text: 'SECRET' }] } }) +
      '\n').token).toBeNull();
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
    expect(detectPendingQuestion(text(ask('permission', 'functions.request_permissions'))))
      .toMatchObject({ token: 'blocking:permission', blocking: true });
  });
});
