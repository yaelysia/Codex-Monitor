import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorAlert } from '../src/shared/types';

const fake = vi.hoisted(() => ({
  notifications: [] as Array<{
    options: Record<string, unknown>;
    listeners: Map<string, Function[]>;
    closed: boolean;
    show(): void;
    close(): void;
    fire(name: string, ...args: unknown[]): void;
  }>,
  supported: true,
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return fake.supported; }
    options: Record<string, unknown>;
    listeners = new Map<string, Function[]>();
    closed = false;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      fake.notifications.push(this);
    }
    on(name: string, cb: Function) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
      return this;
    }
    show() {}
    close() { this.closed = true; this.fire('close'); }
    fire(name: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
  },
}));

import { showDesktopAlert } from '../electron/desktop-notifications';

const alert: MonitorAlert = {
  id: 'alert-1', sessionKey: 'ssh:server:one', sessionId: 'one',
  title: '远程任务', sourceLabel: 'Server', workspace: '/repo',
  statusReason: 'question', kind: 'waiting', questionText: '是否继续执行？',
  at: Date.now(), read: false,
};

beforeEach(() => {
  fake.notifications = [];
  fake.supported = true;
});

describe('native notification acknowledge action', () => {
  it('shows one Windows action button and acknowledges without opening main window', () => {
    const focus = vi.fn();
    const acknowledge = vi.fn();
    showDesktopAlert(alert, focus, acknowledge);
    expect(fake.notifications).toHaveLength(1);
    const notice = fake.notifications[0]!;
    expect(notice.options.actions).toEqual([{ type: 'button', text: '✓ 标记已读' }]);
    expect(notice.options.body).toContain('是否继续执行？');
    notice.fire('action', { actionIndex: 0 });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledWith('alert-1');
    expect(focus).not.toHaveBeenCalled();
    expect(notice.closed).toBe(true);
    notice.fire('action', { actionIndex: 0 });
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it('opens the session if the user clicks notification body, not when clicking action', () => {
    const focus = vi.fn();
    const acknowledge = vi.fn();
    showDesktopAlert({ ...alert, kind: 'finished', questionText: null }, focus, acknowledge);
    const notice = fake.notifications[0]!;
    expect(notice.options.title).toBe('Codex · 本轮回复已结束');
    notice.fire('click');
    expect(focus).toHaveBeenCalledWith(alert.sessionKey);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('accepts positional action-index callbacks on older Electron builds', () => {
    const focus = vi.fn();
    const acknowledge = vi.fn();
    showDesktopAlert(alert, focus, acknowledge);
    const notice = fake.notifications[0]!;
    notice.fire('action', {}, 1);
    expect(acknowledge).not.toHaveBeenCalled();
    notice.fire('action', {}, 0);
    expect(acknowledge).toHaveBeenCalledWith(alert.id);
  });

  it('does not attempt to send an action when native notifications are unavailable', () => {
    fake.supported = false;
    const focus = vi.fn();
    const acknowledge = vi.fn();
    showDesktopAlert(alert, focus, acknowledge);
    expect(fake.notifications).toHaveLength(0);
  });
});
