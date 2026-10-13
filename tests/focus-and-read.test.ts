import { describe, expect, it, vi } from 'vitest';
import type { MonitorAlert, OriginalWindowFocusResult } from '../src/shared/types';
import { focusAndRead } from '../src/shared/focus-and-read';

const entry = (id: string, key: string, read = false): MonitorAlert => ({
  id, sessionKey: key, sessionId: key, kind: 'waiting', title: id,
  sourceLabel: 'Windows', workspace: null, at: 1, read,
  statusReason: 'request pending',
});
const ok: OriginalWindowFocusResult = { state: 'focused', message: 'focused' };

describe('acknowledge only on successful original-window navigation', () => {
  it('marks only preexisting unread alerts of the navigated session', async () => {
    const alerts = [entry('one', 's'), entry('two', 's'), entry('three', 'other'), entry('read', 's', true)];
    const acknowledge = vi.fn();
    const focus = vi.fn(async () => ok);
    expect(await focusAndRead('s', alerts, focus, acknowledge)).toEqual(ok);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(['one', 'two']);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it.each(['unbound', 'unavailable', 'stale', 'blocked'] as const)(
    'does not mark any unread alerts for %s', async state => {
      const acknowledge = vi.fn();
      await focusAndRead('s', [entry('a', 's')], async () => ({ state, message: state }), acknowledge);
      expect(acknowledge).not.toHaveBeenCalled();
    },
  );

  it('does not mark alerts that arrived while a navigation was in flight', async () => {
    const existing = [entry('first', 's')];
    let complete: ((result: OriginalWindowFocusResult) => void) | undefined;
    const focus = new Promise<OriginalWindowFocusResult>(resolve => { complete = resolve; });
    const acknowledge = vi.fn();
    const pending = focusAndRead('s', existing, () => focus, acknowledge);
    existing.push(entry('later', 's'));
    complete?.(ok);
    await pending;
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(['first']);
  });

  it('propagates focus failure without clearing the inbox', async () => {
    const acknowledge = vi.fn();
    await expect(focusAndRead('s', [entry('a', 's')], async () => {
      throw new Error('foreground denied');
    }, acknowledge)).rejects.toThrow('foreground denied');
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

describe('official Desktop protocol acknowledgement semantics', () => {
  it('acknowledges an explicit user navigation handled by the OS protocol', async () => {
    const acknowledge = vi.fn();
    const result: OriginalWindowFocusResult = {
      state: 'opened', message: 'Handed off to installed Codex Desktop',
    };
    expect(await focusAndRead('s', [entry('a', 's')], async () => result, acknowledge))
      .toEqual(result);
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(['a']);
  });
});
