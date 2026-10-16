import { describe, expect, it } from 'vitest';
import { extractSessionId, extractWorkspace, inferStatus } from '../electron/rollout';

const event = (type: string) => JSON.stringify({ type: 'event_msg', payload: { type } });
const session = (id = '01234567-89ab-4cde-8123-123456789abc', cwd = '/home/dev/code') =>
  JSON.stringify({ type: 'session_meta', payload: { id, cwd } });

const NOW = 1_800_000_000_000;

describe('bounded JSONL metadata parsing', () => {
  it('extracts a session id and workspace from session_meta', () => {
    const head = session() + '\n';
    expect(extractSessionId(head, 'rollout.jsonl')).toBe('01234567-89ab-4cde-8123-123456789abc');
    expect(extractWorkspace(head, head)).toBe('/home/dev/code');
  });
  it('extracts cwd from an incomplete oversized metadata line', () => {
    const head = '{"type":"session_meta","payload":{"id":"01234567-89ab-4cde-8123-123456789abc","cwd":"C:\\\\Repo\\\\project","base_instructions":"' + 'x'.repeat(128_000);
    expect(extractWorkspace(head, '')).toBe('C:\\Repo\\project');
  });
  it('uses the latest turn_context cwd after session metadata', () => {
    const head = session();
    const tail = [session(), JSON.stringify({ type: 'turn_context', payload: { cwd: '/home/dev/new' } })].join('\n');
    expect(extractWorkspace(head, tail)).toBe('/home/dev/new');
  });
});

describe('conservative status inference', () => {
  it('shows possible activity only for fresh, unterminated turns', () => {
    expect(inferStatus(`${event('task_started')}\n`, NOW - 10_000, NOW).status).toBe('working');
    expect(inferStatus(`${event('task_started')}\n`, NOW - 150_000, NOW).status).toBe('unknown');
  });
  it('recognizes task and turn aliases for finished turns', () => {
    expect(inferStatus(`${event('turn_started')}\n${event('turn_complete')}`, NOW - 1_000_000, NOW).status).toBe('finished');
    expect(inferStatus(`${event('task_started')}\n${event('turn_aborted')}`, NOW - 2_000, NOW).status).toBe('interrupted');
  });
  it('recognizes explicit permission requests and their resumption', () => {
    expect(inferStatus(`${event('task_started')}\n${event('request_user_input')}`, NOW - 20_000, NOW).status).toBe('waiting');
    expect(inferStatus(`${event('task_started')}\n${event('request_user_input')}\n${event('exec_command_begin')}`, NOW - 10_000, NOW).status).toBe('working');
  });
  it('ignores clipped first lines and malformed incomplete JSON', () => {
    const tail = 'partial-line\n' + event('task_started') + '\n' + '{not json';
    expect(inferStatus(tail, NOW - 4_000, NOW, true).status).toBe('working');
  });
  it('never treats mere recent modification as active', () => {
    expect(inferStatus(session(), NOW - 1_000, NOW).status).toBe('unknown');
  });
});


describe('compaction checkpoint interpretation', () => {
  const json = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ type, timestamp: '2026-10-12T08:00:00Z', payload });
  const compacted = json('compacted', { message: 'checkpoint' });

  it('uses fresh persisted compaction evidence when the start event was clipped', () => {
    const variants = [
      compacted,
      json('event_msg', { type: 'context_compacted' }),
      json('event_msg', { type: 'item_completed', item: { type: 'ContextCompaction', id: 'a' } }),
      json('response_item', { type: 'compaction' }),
    ];
    for (const tail of variants) {
      const status = inferStatus(tail, NOW - 5000, NOW);
      expect(status.status).toBe('working');
      expect(status.statusReason).toMatch(/压缩完成记录/);
      expect(status.finishedToken).toBeNull();
    }
  });

  it('does not mistake an old compaction result for live activity', () => {
    expect(inferStatus(compacted, NOW - 600_000, NOW).status).toBe('unknown');
  });

  it('prefers a later completed turn to compaction progress', () => {
    const tail = [compacted, json('event_msg', { type: 'task_complete', turn_id: 't1' })].join('\n');
    expect(inferStatus(tail, NOW - 5000, NOW)).toMatchObject({
      status: 'finished', finishedToken: '2026-10-12T08:00:00Z|t1',
    });
  });

  it('never leaks a previous turn completion token into fresh compaction activity', () => {
    const tail = [
      json('event_msg', { type: 'task_complete', turn_id: 'prior' }),
      compacted,
    ].join('\n');
    const status = inferStatus(tail, NOW - 5000, NOW);
    expect(status.status).toBe('working');
    expect(status.finishedToken).toBeNull();
  });
});


describe('terminal turn status accuracy', () => {
  it('does not claim an interrupted turn completed normally', () => {
    const tail = [
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted' } },
    ].map(item => JSON.stringify(item)).join('\n');
    const result = inferStatus(tail, NOW - 1000, NOW);
    expect(result.status).toBe('interrupted');
    expect(result.finishedToken).toBeNull();
    expect(result.interruptedToken).toBe('|t1');
  });
  it('tracks distinct aborted turns and clears their fingerprints after a new start', () => {
    const boundary = (kind: string, turnId: string, at: string) => JSON.stringify({
      type: 'event_msg', timestamp: at, payload: { type: kind, turn_id: turnId },
    });
    const first = [boundary('turn_started', 'a', '2026-10-12T10:00:00Z'),
      boundary('turn_aborted', 'a', '2026-10-12T10:00:03Z')];
    expect(inferStatus(first.join('\n'), NOW - 1000, NOW)).toMatchObject({
      status: 'interrupted', interruptedToken: '2026-10-12T10:00:03Z|a',
    });
    const second = [...first, boundary('turn_started', 'b', '2026-10-12T10:00:04Z'),
      boundary('turn_aborted', 'b', '2026-10-12T10:00:05Z')];
    expect(inferStatus(second.join('\n'), NOW - 1000, NOW)).toMatchObject({
      status: 'interrupted', interruptedToken: '2026-10-12T10:00:05Z|b',
    });
    const resumed = [...second, boundary('turn_started', 'c', '2026-10-12T10:00:06Z')];
    expect(inferStatus(resumed.join('\n'), NOW - 1000, NOW)).toMatchObject({
      status: 'working', interruptedToken: null,
    });
  });
  it('detects a completed turn with a non-null error as a failure instead of success', () => {
    const text = JSON.stringify({ type: 'event_msg', payload: {
      type: 'turn_complete', turn_id: 'turn2', error: { message: 'tool failed' },
    } });
    const result = inferStatus(text, NOW - 1000, NOW);
    expect(result.status).toBe('failed');
    expect(result.finishedToken).toBeNull();
    expect(result.failedToken).toBe('|turn2');
    expect(result.failureTokens).toEqual(['|turn2']);
  });
  it('keeps error event identities after a later turn starts, without saving error text', () => {
    const eventRow = (kind: string, turn: string, stamp: string, failed = false) =>
      JSON.stringify({ type: 'event_msg', timestamp: stamp,
        payload: { type: kind, turn_id: turn,
          ...(failed ? { error: { message: 'PRIVATE_FAILURE_TEXT' } } : {}) } });
    const lines = [
      eventRow('turn_started', 'a', '2026-10-12T10:00:00Z'),
      eventRow('turn_complete', 'a', '2026-10-12T10:00:01Z', true),
      eventRow('turn_started', 'b', '2026-10-12T10:00:02Z'),
      eventRow('turn_complete', 'b', '2026-10-12T10:00:03Z', true),
      eventRow('turn_started', 'c', '2026-10-12T10:00:04Z'),
    ].join('\n');
    const result = inferStatus(lines, NOW - 1000, NOW);
    expect(result.status).toBe('working');
    expect(result.failedToken).toBeNull();
    expect(result.failureTokens).toEqual([
      '2026-10-12T10:00:01Z|a', '2026-10-12T10:00:03Z|b',
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_FAILURE_TEXT');
  });

  it('does not mistake a completion with error:null for a failure', () => {
    const text = JSON.stringify({ type: 'event_msg', payload: {
      type: 'turn_complete', turn_id: 'turn3', error: null,
    } });
    const result = inferStatus(text, NOW - 1000, NOW);
    expect(result.status).toBe('finished');
    expect(result.failureTokens).toEqual([]);
    expect(result.failedToken).toBeNull();
  });
});


describe('VS Code structured async question after newer turn starts', () => {
  it('keeps an unanswered persisted agent_message request actionable after newer turn markers', () => {
    const records=[
      {type:'event_msg',payload:{type:'turn_started',turn_id:'a'}},
      {type:'response_item',payload:{type:'agent_message',id:'ask-1',
        delivery:'async',questions:[{question:'下一步如何做？'}]}},
      {type:'event_msg',payload:{type:'turn_complete',turn_id:'a'}},
      {type:'event_msg',payload:{type:'turn_started',turn_id:'b'}},
    ].map(item=>JSON.stringify(item)).join('\n');
    const state=inferStatus(records,NOW-1000,NOW);
    expect(state.status).toBe('working'); // new turn may run while the async question remains outstanding
    expect(state.pendingQuestionToken).toBe('async:ask-1');
    expect(state.questionText).toBe('下一步如何做？');
  });
});

describe('persisted Codex question state inference', () => {
  const r = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ type, payload });
  const ask = (id: string) => r('response_item', {
    type: 'function_call', name: 'request_user_input', call_id: id,
    arguments: JSON.stringify({ questions: [{ question: '继续部署生产环境吗？' }] }),
  });
  const reply = (id: string) => r('response_item', {
    type: 'function_call_output', call_id: id, output: '{"answers":{"confirm":"yes"}}',
  });
  it('recognizes a blocking request even if transient event_msg was not persisted', () => {
    const state = inferStatus([event('task_started'), ask('call-1')].join('\n'), NOW - 10_000, NOW);
    expect(state).toMatchObject({
      status: 'waiting',
      pendingQuestionToken: 'blocking:call-1',
      questionText: '继续部署生产环境吗？',
      waitingToken: 'blocking:call-1',
      finishedToken: null,
    });
  });
  it('keeps explicit question evidence while ordinary 90-second active inference expires', () => {
    const status = inferStatus([event('task_started'), ask('call-1')].join('\n'),
      NOW - 11 * 60_000, NOW);
    expect(status.status).toBe('waiting');
    expect(status.statusReason).toMatch(/未匹配回答/);
  });
  it('clears pending user question on matching function_call_output', () => {
    const state = inferStatus([event('task_started'), ask('call-1'), reply('call-1')].join('\n'),
      NOW - 1000, NOW);
    expect(state.status).toBe('working');
    expect(state.pendingQuestionToken).toBeNull();
    expect(state.waitingToken).toBeNull();
  });
  it('uses async question item as an independent pending request without stopping the turn', () => {
    const state = inferStatus([
      event('task_started'),
      r('event_msg', { type: 'item_completed', item: {
        type: 'AgentMessage', id: 'ask-a', delivery: 'async',
        questions: [{ title: '哪个分支要发布？' }],
      } }),
      r('event_msg', { type: 'turn_complete', turn_id: 'turn-a' }),
    ].join('\n'), NOW - 1000, NOW);
    expect(state).toMatchObject({
      status: 'unknown', pendingQuestionToken: 'async:ask-a',
      questionText: '哪个分支要发布？',
    });
    expect(inferStatus([
      event('task_started'),
      r('event_msg', { type: 'item_completed', item: {
        type: 'AgentMessage', id: 'ask-a', delivery: 'async',
        questions: [{ title: '哪个分支要发布？' }],
      } }),
      r('event_msg', { type: 'user_message', message: 'release' }),
      r('event_msg', { type: 'turn_complete' }),
    ].join('\n'), NOW - 1000, NOW).pendingQuestionToken).toBeNull();
  });
  it('does not assert a weeks-old unmatched tool call is definitely awaiting input', () => {
    const state = inferStatus([event('task_started'), ask('call-1')].join('\n'),
      NOW - 8 * 60 * 60_000, NOW);
    expect(state.pendingQuestionToken).toBeNull();
    expect(state.status).toBe('unknown');
  });
});

describe('Codex Desktop paginated turn lifecycle', () => {
  const row = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ type, timestamp: '2026-10-12T10:15:00Z', payload });
  const boundary = (event: string, turn: string) =>
    row('event_msg', { type: event, turn_id: turn });
  const paginatedInput = (kind = 'UserMessage') =>
    row('event_msg', { type: 'item_completed', item: {
      type: kind, id: 'message-2', content: [{ type: 'Text', text: 'PRIVATE MESSAGE' }],
    } });

  it('does not close active turn-b upon receiving delayed turn-a completion', () => {
    const data = [boundary('turn_started', 'turn-a'), boundary('turn_complete', 'turn-a'),
      boundary('turn_started', 'turn-b'), boundary('turn_complete', 'turn-a')].join('\n');
    const result = inferStatus(data, NOW - 1000, NOW);
    expect(result.status).toBe('working');
    expect(result.finishedToken).toBeNull();
  });

  it('does not reuse prior completion when a new paginated user message arrives', () => {
    const data = [boundary('turn_started', 'turn-a'), boundary('turn_complete', 'turn-a'),
      paginatedInput()].join('\n');
    expect(inferStatus(data, NOW - 1200, NOW)).toMatchObject({
      status: 'working', finishedToken: null,
    });
    expect(inferStatus(data, NOW - 180_000, NOW).status).toBe('unknown');
    const staleDuplicate = data + '\n' + boundary('turn_complete', 'turn-a');
    expect(inferStatus(staleDuplicate, NOW - 1200, NOW).status).toBe('working');
  });

  it('accepts genuine completion of a new turn without treating it as old', () => {
    const data = [
      boundary('turn_started', 'turn-a'), boundary('turn_complete', 'turn-a'),
      paginatedInput(), boundary('turn_started', 'turn-b'),
      boundary('turn_complete', 'turn-a'), boundary('turn_complete', 'turn-b'),
    ].join('\n');
    expect(inferStatus(data, NOW - 1200, NOW)).toMatchObject({
      status: 'finished', finishedToken: '2026-10-12T10:15:00Z|turn-b',
    });
  });

  it('does not declare the user task finished when a structured async question is outstanding', () => {
    const data = [
      boundary('turn_started', 'turn-a'),
      row('event_msg', { type: 'item_completed',
        item: { type: 'AgentMessage', id: 'q-1', delivery: 'async',
          questions: [{ title: '继续执行吗？' }] } }),
      boundary('turn_complete', 'turn-a'),
    ].join('\n');
    const result = inferStatus(data, NOW - 1000, NOW);
    expect(result).toMatchObject({
      status: 'unknown', finishedToken: null, pendingQuestionToken: 'async:q-1',
    });
    expect(result.statusReason).toContain('尚未回答');
  });

  it('does not treat a user response item as a completion marker', () => {
    const data = [boundary('turn_complete', 'old'),
      row('response_item', { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'PRIVATE RESPONSE' }] })].join('\n');
    expect(inferStatus(data, NOW - 1000, NOW)).toMatchObject({
      status: 'working', finishedToken: null,
    });
  });
});

describe('aborted event history survives subsequent turns', () => {
  const row = (kind: string, turnId: string, time: string) =>
    JSON.stringify({ type: 'event_msg', timestamp: time,
      payload: { type: kind, turn_id: turnId } });
  it('returns both abort markers after two quick restarts, even when the latest turn is working', () => {
    const tail = [
      row('turn_started', 'a', '2026-10-12T10:00:00Z'),
      row('turn_aborted', 'a', '2026-10-12T10:00:01Z'),
      row('turn_started', 'b', '2026-10-12T10:00:02Z'),
      row('turn_aborted', 'b', '2026-10-12T10:00:03Z'),
      row('turn_started', 'c', '2026-10-12T10:00:04Z'),
    ].join('\n');
    const parsed = inferStatus(tail, NOW - 1_000, NOW);
    expect(parsed.status).toBe('working');
    expect(parsed.interruptedToken).toBeNull();
    expect(parsed.interruptionTokens).toEqual([
      '2026-10-12T10:00:01Z|a', '2026-10-12T10:00:03Z|b',
    ]);
  });
});

describe('strong turn identity safety', () => {
  const evt = (event: string, turnId?: string) => JSON.stringify({
    type: 'event_msg', payload: { type: event, ...(turnId ? { turn_id: turnId } : {}) },
  });

  it('rejects an uncorrelated old finish marker while a named turn is running', () => {
    const rows = [evt('turn_started', 'old'), evt('turn_complete', 'old'),
      evt('turn_started', 'current'), evt('task_complete')].join('\n');
    expect(inferStatus(rows, NOW - 5000, NOW)).toMatchObject({
      status: 'working', finishedToken: null,
    });
  });

  it('retains the legacy completion fallback when neither event has turn ID', () => {
    expect(inferStatus([evt('task_started'), evt('task_complete')].join('\n'),
      NOW - 1000, NOW)).toMatchObject({ status: 'finished' });
  });
});
