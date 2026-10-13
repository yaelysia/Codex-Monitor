import type { MonitorAlert, OriginalWindowFocusResult } from './types';

/** Mark only alerts that were unread when user navigation succeeded:
 * either a verified HWND activation or the OS accepting an official Desktop
 * protocol URL. This does not claim that Desktop rendered the thread.
 * Later arrivals and other sessions are safe; no Codex approval is sent.
 */
export async function focusAndRead(
  sessionKey: string,
  alerts: readonly MonitorAlert[],
  focus: () => Promise<OriginalWindowFocusResult>,
  acknowledge: (ids: readonly string[]) => void,
): Promise<OriginalWindowFocusResult> {
  const ids = alerts.filter(alert => alert.sessionKey === sessionKey && !alert.read)
    .map(alert => alert.id);
  const outcome = await focus();
  if ((outcome.state === 'focused' || outcome.state === 'opened') && ids.length) acknowledge(ids);
  return outcome;
}
