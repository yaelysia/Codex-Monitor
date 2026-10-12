import { Notification } from 'electron';
import type { MonitorAlert } from '../src/shared/types';

/** Best-effort operating-system toast; the dock's unread indicator works even without it. */
export function showDesktopAlert(alert: MonitorAlert, focus: (sessionKey: string) => void): void {
  if (!Notification.isSupported()) return;
  try {
    const notice = new Notification({
      title: alert.kind === 'finished' ? 'Codex · 本轮任务完成' : 'Codex · 可能需要处理',
      body: [alert.title, alert.sourceLabel].join(' · ').slice(0, 240),
    });
    notice.on('click', () => focus(alert.sessionKey));
    notice.show();
  } catch (error) {
    console.warn('[Codex Monitor] Desktop notification unavailable', error);
  }
}
