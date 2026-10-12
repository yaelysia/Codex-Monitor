import type { MonitorAlert, SessionRecord } from './types';

/** Keep subagents in the collector, but hide them from user-facing session lists
 * unless the user explicitly asks to inspect them. Never mutate scan records.
 */
export function visibleSessions(sessions: readonly SessionRecord[], showSubagents = false): SessionRecord[] {
  return showSubagents ? [...sessions] :
    sessions.filter(session => session.isSubagent !== true);
}

/** A legacy alert may exist while a child is visible in older monitor state.
 * Filter that as well so floating counts and inbox match the parent-only UI.
 */
export function visibleAlerts(alerts: readonly MonitorAlert[],
  sessions: readonly SessionRecord[], showSubagents = false): MonitorAlert[] {
  if (showSubagents) return [...alerts];
  const hiddenKeys = new Set(sessions.filter(session => session.isSubagent === true)
    .map(session => session.key));
  return alerts.filter(alert => !hiddenKeys.has(alert.sessionKey));
}
