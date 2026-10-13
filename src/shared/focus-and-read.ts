import type { MonitorAlert, OriginalWindowFocusResult } from './types';

/** Mark only alerts that were unread when the user initiated a successful
 * switch to their original window. Later arrivals and other sessions are safe.
 * This is a UI acknowledgement, never an answer or Codex approval.
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
