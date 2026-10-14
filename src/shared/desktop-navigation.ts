import type { SessionRecord } from './types';

const THREAD_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Official Codex Desktop thread deep link, also used by upstream codex-rs
 * TUI's "open in desktop" action. Never interpolate arbitrary user input.
 * An originator is the session's CREATOR; alternatively accept exact UUID
 * runtime ownership proven by a first-party Desktop lifecycle event.
 */
export function desktopThreadUrl(
  session: Pick<SessionRecord, 'id' | 'clientKind' | 'desktopRuntimeObserved' | 'isSubagent'> | null | undefined,
): string | null {
  if (!session || session.isSubagent === true ||
      !(session.clientKind === 'desktop' || session.desktopRuntimeObserved === true) ||
      !THREAD_UUID.test(session.id)) return null;
  return 'codex://threads/' + session.id.toLowerCase();
}
