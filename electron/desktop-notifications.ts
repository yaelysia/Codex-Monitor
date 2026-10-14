import { Notification } from 'electron';
import type { MonitorAlert } from '../src/shared/types';

const activeNotices = new Set<Notification>();

/** The action button only acknowledges the Monitor alert; it never answers
 * a Codex question, approves a tool, or changes a remote session. */
export function showDesktopAlert(
  alert: MonitorAlert,
  focus: (sessionKey: string) => void,
  acknowledge: (alertId: string) => void,
): void {
  if (!Notification.isSupported()) return;
  try {
    const notice = new Notification({
      title: alert.kind === 'finished' ? 'Codex · 本轮回复已结束' : 'Codex · 等待用户处理',
      body: [alert.title, alert.questionText, alert.sourceLabel]
        .filter(Boolean).join(' · ').slice(0, 240),
      actions: [{ type: 'button', text: '✓ 标记已读' }],
    });
    let acknowledged = false;
    notice.on('action', (event, index) => {
      // Electron supports both the legacy positional index and its newer
      // Event<> detail actionIndex, depending on the exact Electron build.
      const detailIndex = (event as { actionIndex?: unknown }).actionIndex;
      const actionIndex = typeof detailIndex === 'number' ? detailIndex : index;
      if (actionIndex !== 0 || acknowledged) return;
      acknowledged = true;
      acknowledge(alert.id);
      notice.close();
      activeNotices.delete(notice);
    });
    notice.on('click', () => {
      // Clicking the notification is itself an acknowledgement, regardless of
      // whether Windows subsequently permits the window navigation.
      if (acknowledged) return;
      acknowledged = true;
      acknowledge(alert.id);
      notice.close();
      activeNotices.delete(notice);
      focus(alert.sessionKey);
    });
    notice.on('close', () => activeNotices.delete(notice));
    activeNotices.add(notice);
    notice.show();
  } catch (error) {
    console.warn('[Codex Monitor] Desktop notification unavailable', error);
  }
}
