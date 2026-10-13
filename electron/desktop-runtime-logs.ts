import { desktopLogRoots, discoverDesktopLogFiles } from '../scripts/desktop-log-discovery.mjs';
import { DesktopLogFollower } from '../scripts/desktop-log-follower.mjs';
import { parseDesktopLogEvent, newestDesktopEvents,
  type DesktopLogEvent } from '../src/shared/desktop-log-status';

const liveFollower = new DesktopLogFollower();

/** Shared discovery for the Monitor and the support CLI; no duplicate
 * hard-coded date/package heuristics that silently disagree on real Windows.
 */
export async function findDesktopLogRoots(localAppData: string): Promise<string[]> {
  return (await desktopLogRoots(localAppData)).map(root => root.path);
}

export interface DesktopLogSummary {
  events: Map<string, DesktopLogEvent>;
  logFilesRead: number;
  signalCount: number;
  /** No raw paths, filenames, log records, thread IDs or account details. */
  discovery: {
    validLocalAppData: boolean;
    rootCount: number;
    existingRootCount: number;
    readableDayFolders: number;
    matchingLogNames: number;
    recentCandidateCount: number;
    unreadBacklogFiles?: number;
  };
}

/** Bootstrap each log's recent tail, then read appended COMPLETE lines across
 * polls. A fast-growing log cannot silently push turn/start outside a fixed
 * tail between four-second audits. Only validated lifecycle IDs are retained.
 */
export async function inspectDesktopLogSignals(now = Date.now(),
  localAppData = process.env.LOCALAPPDATA ?? '',
  follower: DesktopLogFollower = liveFollower): Promise<DesktopLogSummary> {
  const found = await discoverDesktopLogFiles(localAppData, now);
  const coverage = {
    validLocalAppData: found.validLocalAppData,
    rootCount: found.roots.length,
    existingRootCount: found.roots.filter(root => root.exists).length,
    readableDayFolders: found.roots.reduce((n,r) => n + r.accessibleDateFolders, 0),
    matchingLogNames: found.roots.reduce((n,r) => n + r.matchedNames, 0),
    recentCandidateCount: found.files.length,
  };
  const events: DesktopLogEvent[] = [];
  const tracked = await follower.scan(found.files, line => {
    const event = parseDesktopLogEvent(line, now);
    if (event) events.push(event);
  });
  return {
    events: newestDesktopEvents(events),
    // Followed files remain readable even when they have not grown this tick.
    logFilesRead: tracked.trackedFiles,
    signalCount: events.length,
    discovery: { ...coverage, unreadBacklogFiles: tracked.backlogFiles },
  };
}

export async function readDesktopLogSignals(now = Date.now(),
  localAppData = process.env.LOCALAPPDATA ?? ''): Promise<Map<string, DesktopLogEvent>> {
  // Standalone one-shot readers must not consume the Monitor's live cursor.
  return (await inspectDesktopLogSignals(now, localAppData, new DesktopLogFollower())).events;
}
