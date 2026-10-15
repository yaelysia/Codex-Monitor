import type { ScanResponse, SessionRecord, SourceResult } from './types';

/** Convert a source-clock file mtime to the Monitor machine's approximate
 * timeline using the age observed on THAT source. Never compare remote wall
 * clocks directly. No mutation of collector evidence or session identity.
 */
export function sessionObservedAt(
  session: SessionRecord,
  source: Pick<SourceResult, 'capturedAt'>,
): number {
  const age = session.ageAtSourceMs;
  const at = source.capturedAt;
  return typeof age === 'number' && Number.isFinite(age) &&
    typeof at === 'number' && Number.isFinite(at)
    ? at - age : session.updatedAt;
}

/** UI-only projection; collectors, alerts and window binding retain the
 * authoritative source timestamps. All views sort/filter by local time.
 */
export function projectSessionsToLocalTime(scan: ScanResponse | null): SessionRecord[] {
  if (!scan) return [];
  return scan.sources.flatMap(source => source.sessions.map(session => {
    const updatedAt = sessionObservedAt(session, source);
    return updatedAt === session.updatedAt ? session : { ...session, updatedAt };
  }));
}
