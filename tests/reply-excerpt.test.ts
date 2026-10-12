import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { latestReplyExcerpt, EXCERPT_CHARS, validRolloutPath } from '../src/shared/reply-excerpt';
import { readLocalRecentReply, readRecentReply } from '../electron/reply-preview';
import type { ScanResponse, Settings } from '../src/shared/types';

const jsonl = (...rows: Record<string, unknown>[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })));
});

describe('bounded user-visible assistant reply parser', () => {
  it('selects the newest assistant message over older finals; skips reasoning and tool output', () => {
    const text = jsonl(
      { type: 'event_msg', payload: { type: 'agent_message', message: '早期最终回复', phase: 'final_answer' } },
      { type: 'response_item', payload: { type: 'reasoning', content: [{ type: 'summary_text', text: '内部推理' }] } },
      { type: 'response_item', payload: { type: 'function_call_output', output: '敏感工具结果' } },
      { type: 'response_item', timestamp: '2026-10-12T08:40:00Z',
        payload: { type: 'message', role: 'assistant', phase: 'commentary',
          content: [{ type: 'output_text', text: '现在修复最后一个测试。' }] } },
    );
    expect(latestReplyExcerpt(text, false)).toEqual({
      text: '现在修复最后一个测试。', phase: 'commentary',
      timestamp: '2026-10-12T08:40:00Z', truncated: false,
    });
  });

  it('handles paginated completed AgentMessage and legacy events', () => {
    const text = jsonl(
      { type: 'event_msg', payload: { type: 'agent_message', phase: 'final_answer', message: '上一条' } },
      { type: 'event_msg', timestamp: '2026-10-12T09:00:00Z',
        payload: { type: 'item_completed', item: { type: 'AgentMessage', phase: 'final_answer',
          content: [{ type: 'Text', text: '新回复第一行' }, { type: 'Text', text: '新回复第二行' }] } } },
      { type: 'event_msg', payload: { type: 'token_count', info: {} } },
    );
    expect(latestReplyExcerpt(text, false)).toMatchObject({
      text: '新回复第一行\n新回复第二行', phase: 'final_answer',
    });
  });

  it('supports task_complete last_agent_message as fallback and never exposes an internal analysis message', () => {
    const text = jsonl(
      { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'analysis',
        content: [{ type: 'output_text', text: '不要显示' }] } },
      { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '已修复并通过测试。' } },
    );
    expect(latestReplyExcerpt(text, false)).toMatchObject({
      text: '已修复并通过测试。', phase: 'final_answer',
    });
  });

  it('shows a 420-character suffix without splitting astral Unicode characters', () => {
    const content = '开始' + '🙂'.repeat(450);
    const preview = latestReplyExcerpt(jsonl({ type: 'event_msg', payload: {
      type: 'agent_message', message: content,
    } }), false);
    expect(Array.from(preview.text || '')).toHaveLength(EXCERPT_CHARS + 1);
    expect(preview.text?.startsWith('…')).toBe(true);
    expect(preview.text?.endsWith('🙂')).toBe(true);
    expect(preview.truncated).toBe(true);
  });

  it('ignores incomplete clipped lines, invalid JSON and hidden tool messages', () => {
    const text = 'half-json\n' + jsonl(
      { type: 'event_msg', payload: { type: 'agent_message', message: '真实回复' } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '不是助手回复' }] } },
    ) + '{ incomplete';
    expect(latestReplyExcerpt(text, true).text).toBe('真实回复');
    expect(latestReplyExcerpt(jsonl({ type: 'event_msg',
      payload: { type: 'agent_reasoning', text: '推理' } }), false).text).toBeNull();
  });

  it('validates relative session paths and refuses traversal', () => {
    expect(validRolloutPath('2026/10/12/rollout-abc.jsonl')).toBe(true);
    for (const value of ['../../secret', '/etc/passwd', '2026/10/12/../secret.jsonl',
      '2026/10/12/../../secret.jsonl', '2026\\10\\12\\rollout.jsonl', '2026/10/12/evil.txt']) {
      expect(validRolloutPath(value)).toBe(false);
    }
  });
});

describe('on-demand local reader and scan-scoped access', () => {
  it('reads the selected file only and falls back beyond short tail', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-preview-'));
    created.push(root);
    const rel = '2026/10/12/rollout-example.jsonl';
    const file = path.join(root, 'sessions', ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, jsonl(
      { type: 'event_msg', payload: { type: 'agent_message', message: '最后一次有意义的回复' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(280_000) } },
    ));
    expect((await readLocalRecentReply(root, rel)).text).toBe('最后一次有意义的回复');
    await expect(readLocalRecentReply(root, '2026/10/12/../../../private.jsonl')).rejects.toThrow();
    const scan: ScanResponse = {
      scannedAt: Date.now(),
      sources: [{ id: 'local', label: 'Windows', kind: 'local', error: null, sessions: [{
        id: 'abc', key: 'local:abc', sourceId: 'local', sourceLabel: 'Windows',
        title: '标题', workspace: '/repo', status: 'finished',
        statusReason: 'done', updatedAt: Date.now(), startedAt: null, rolloutPath: rel,
      }] }],
    };
    const settings: Settings = { localRoot: root, wslRoots: {}, remotes: [] };
    expect((await readRecentReply('local:abc', scan, settings)).text).toBe('最后一次有意义的回复');
    await expect(readRecentReply('local:unindexed', scan, settings)).rejects.toThrow();
  });
});
