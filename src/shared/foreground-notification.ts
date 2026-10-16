import type { MonitorAlert } from './types';
import { isSourceAlertKind } from './source-alert';

/** Apply native popup suppression at the last possible boundary. The
 * persisted inbox, unread counts, other sessions and global mute continue to
 * work. Source outage/recovery notices have NO specific foreground thread.
 */
export function shouldDisplayNativeAlert(
  alert: Pick<MonitorAlert, 'kind' | 'sessionKey'>,
  isSessionForeground: (sessionKey: string) => boolean,
): boolean {
  if (isSourceAlertKind(alert.kind)) return true;
  try {
    return !isSessionForeground(alert.sessionKey);
  } catch {
    // A failed/disabled OS watcher should never silently lose notifications.
    return true;
  }
}
