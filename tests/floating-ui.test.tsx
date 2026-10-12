import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FloatingApp from '../src/renderer/FloatingApp';
import { inferStatus } from '../electron/rollout';

describe('edge floating window renderer', () => {
  it('renders compact rail actions before its first live scan', () => {
    const html = renderToStaticMarkup(createElement(FloatingApp));
    expect(html).toContain('Codex Monitor 边缘悬浮窗');
    expect(html).toContain('可能执行中');
    expect(html).toContain('未读提醒');
    expect(html).toContain('最近完成');
    expect(html).toContain('收起');
  });

  it('keeps a stable terminal event fingerprint distinct from last file modification', () => {
    const now = 1_800_000_000_000;
    const rows = [
      { type: 'event_msg', timestamp: '2026-10-12T08:00:00Z',
        payload: { type: 'task_started', turn_id: 'turn-one' } },
      { type: 'event_msg', timestamp: '2026-10-12T08:00:09Z',
        payload: { type: 'task_complete', turn_id: 'turn-one' } },
    ].map(row => JSON.stringify(row)).join('\n');
    expect(inferStatus(rows, now - 5000, now)).toMatchObject({
      status: 'finished', finishedToken: '2026-10-12T08:00:09Z|turn-one',
    });
  });
});
