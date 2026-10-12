import fs from 'node:fs/promises';
import { desktopLogRoots, discoverDesktopLogFiles } from '../scripts/desktop-log-discovery.mjs';
import { parseDesktopLogEvent, newestDesktopEvents,
  type DesktopLogEvent } from '../src/shared/desktop-log-status';

const MAX_LOG_FILES = 12;
const MAX_FILE_TAIL = 320 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

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
  };
}

/** Reads only a bounded recent tail of first-party Codex Desktop log files,
 * after shared metadata-only discovery. Never returns any raw log line.
 */
export async function inspectDesktopLogSignals(now = Date.now(),
  localAppData = process.env.LOCALAPPDATA ?? ''): Promise<DesktopLogSummary> {
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
  let filesRead = 0;
  let budget = MAX_TOTAL_BYTES;
  for (const item of found.files.slice(0, MAX_LOG_FILES)) {
    if (budget <= 0) break;
    const length = Math.min(budget, item.size, MAX_FILE_TAIL);
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(item.path, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, item.size - length);
      if (!bytesRead) continue;
      filesRead++;
      budget -= bytesRead;
      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split(/\r?\n/);
      if (length < item.size) lines.shift();
      if (!chunk.endsWith('\n')) lines.pop();
      for (const line of lines) {
        const event = parseDesktopLogEvent(line, now);
        if (event) events.push(event);
      }
    } catch { /* Desktop may rotate or lock log files while writing. */ }
    finally { await handle?.close().catch(() => {}); }
  }
  return { events: newestDesktopEvents(events),
    logFilesRead: filesRead, signalCount: events.length, discovery: coverage };
}

export async function readDesktopLogSignals(now = Date.now(),
  localAppData = process.env.LOCALAPPDATA ?? ''): Promise<Map<string, DesktopLogEvent>> {
  return (await inspectDesktopLogSignals(now, localAppData)).events;
}
