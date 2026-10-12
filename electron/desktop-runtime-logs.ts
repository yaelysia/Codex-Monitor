import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDesktopLogEvent, newestDesktopEvents,
  type DesktopLogEvent } from '../src/shared/desktop-log-status';

const MAX_PACKAGE_ENTRIES = 150;
const MAX_LOG_FILES = 12;
const MAX_FILE_TAIL = 320 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_ROOTS = 5;
const MAX_SCAN_AGE_MS = 24 * 60 * 60_000;
const LOG_FILE = /^codex-desktop-[A-Za-z0-9._-]{1,175}\.log$/;

/** Default + MSIX virtualized Windows log roots. A real Desktop installation
 * may use either, or both during migration. Never create directories.
 */
export async function findDesktopLogRoots(localAppData: string): Promise<string[]> {
  if (!localAppData || !path.isAbsolute(localAppData)) return [];
  const roots = [path.join(localAppData, 'Codex', 'Logs')];
  const packages = path.join(localAppData, 'Packages');
  try {
    const entries = await fs.readdir(packages, { withFileTypes: true });
    for (const entry of entries.slice(0, MAX_PACKAGE_ENTRIES)) {
      if (entry.isDirectory() && /^OpenAI\.Codex_[A-Za-z0-9._-]+$/i.test(entry.name)) {
        roots.push(path.join(packages, entry.name, 'LocalCache', 'Local', 'Codex', 'Logs'));
        if (roots.length >= MAX_ROOTS) break;
      }
    }
  } catch { /* Standalone installs may not have an MSIX package directory. */ }
  return roots;
}

interface Candidate { path: string; size: number; mtimeMs: number }

export interface DesktopLogSummary {
  events: Map<string, DesktopLogEvent>;
  logFilesRead: number;
  signalCount: number;
}

/** Bounded metadata-only read: retain parsed event types and UUIDs, never text.
 * Most installations emit a small number of Desktop log files per day, but
 * stop scanning after a fixed file/byte budget to protect runtime performance.
 */
export async function inspectDesktopLogSignals(now = Date.now(),
  localAppData = process.env.LOCALAPPDATA ?? ''): Promise<DesktopLogSummary> {
  const roots = await findDesktopLogRoots(localAppData);
  const datePaths: string[] = [];
  for (const root of roots) {
    for (let days = 0; days <= 1; days++) {
      const stamp = new Date(now - days * 24 * 60 * 60_000);
      // Local Windows log partitions are by local calendar date. UTC-only
      // probing near midnight can miss today's active log; include nearby days.
      for (const offset of [-1, 0, 1]) {
        const date = new Date(stamp.getTime() + offset * 24 * 60 * 60_000);
        const y = String(date.getFullYear());
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        datePaths.push(path.join(root, y, m, d));
      }
    }
  }
  const directories = [...new Set(datePaths)].slice(0, MAX_ROOTS * 4);
  const candidates: Candidate[] = [];
  for (const directory of directories) {
    try {
      const entries = (await fs.readdir(directory, { withFileTypes: true }))
        .filter(ent => ent.isFile() && LOG_FILE.test(ent.name)).slice(0, 64);
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0 && stat.size <= 500 * 1024 * 1024 &&
            stat.mtimeMs >= now - MAX_SCAN_AGE_MS && stat.mtimeMs <= now + 60_000) {
          candidates.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
        }
      }
    } catch { /* Missing date partition or temporarily locked file. */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const events: DesktopLogEvent[] = [];
  let filesRead = 0;
  let budget = MAX_TOTAL_BYTES;
  for (const item of candidates.slice(0, MAX_LOG_FILES)) {
    if (budget <= 0) break;
    const length = Math.min(budget, item.size, MAX_FILE_TAIL);
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(item.path, 'r');
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, item.size - length);
      budget -= bytesRead;
      if (bytesRead) filesRead++;
      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split(/\r?\n/);
      if (length < item.size) lines.shift(); // Incomplete initial line
      if (lines.length && lines.at(-1) && !chunk.endsWith('\n')) lines.pop();
      for (const line of lines) {
        const event = parseDesktopLogEvent(line, now);
        if (event) events.push(event);
      }
    } catch { /* A live Desktop may rotate a log mid-read. */ }
    finally { await handle?.close().catch(() => {}); }
  }
  return { events: newestDesktopEvents(events),
    logFilesRead: filesRead, signalCount: events.length };
}

export async function readDesktopLogSignals(now = Date.now(),
  localAppData = process.env.LOCALAPPDATA ?? ''): Promise<Map<string, DesktopLogEvent>> {
  return (await inspectDesktopLogSignals(now, localAppData)).events;
}
