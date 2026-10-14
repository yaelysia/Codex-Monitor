/** Shared, bounded, READ-ONLY Desktop log discovery. Used by the Monitor
 * runtime and the one-command diagnostic. No filenames or paths are emitted
 * in user-facing output, and this module never reads log bodies.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ROOTS = 8;
const MAX_ENTRIES_PER_DIRECTORY = 300;
const MAX_FILES = 120;
const MAX_PACKAGE_NAMES = 10;
const MAX_LOG_SIZE = 500 * 1024 * 1024;
const MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const LOG_FILENAME = /^codex-desktop-[a-z0-9._-]{1,200}\.log$/i;
const PACKAGE = /^OpenAI\.Codex_[a-z0-9._-]+$/i;
const DAY_OFFSETS = [0, -1, -2, -3, 1];
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
const validRoot = p => typeof p === 'string' && !!p && path.isAbsolute(p);

/** Cache only directory entry names/types, not log contents or file sizes.
 * Each pass still stats candidate log files, so append-based events remain
 * visible on the original four-second cadence. New files invalidate on dir
 * mtime change, with a 30-second safety refresh for coarse filesystems.
 */
export class DesktopDirectoryCache {
  constructor() {
    this.entries = new Map();
    this.cacheHits = 0;
    this.enumerations = 0;
  }
  stats() { return { cacheHits: this.cacheHits, enumerations: this.enumerations }; }
  async read(directory, now = Date.now()) {
    let stat;
    try { stat = await fs.stat(directory); }
    catch { this.entries.delete(directory); return null; }
    if (!stat.isDirectory()) { this.entries.delete(directory); return null; }
    const previous = this.entries.get(directory);
    if (previous && previous.mtimeMs === stat.mtimeMs &&
        now >= previous.checkedAt && now - previous.checkedAt < 30_000) {
      this.cacheHits++;
      return previous.items;
    }
    try {
      const items = await fs.readdir(directory, { withFileTypes: true });
      this.enumerations++;
      this.entries.delete(directory);
      this.entries.set(directory, { mtimeMs: stat.mtimeMs, checkedAt: now, items });
      while (this.entries.size > 80) this.entries.delete(this.entries.keys().next().value);
      return items;
    } catch {
      this.entries.delete(directory);
      return null;
    }
  }
}

/** Prefer both the canonical Store package and dynamically discovered package
 * identities. In particular, never slice Package directory entries BEFORE
 * filtering for Codex: directories are not guaranteed to be alphabetic.
 */
export async function desktopLogRoots(localAppData, appData = process.env.APPDATA ?? '',
  cache = null, now = Date.now()) {
  if (!validRoot(localAppData)) return [];
  const roots = [
    { kind: 'standard', path: path.join(localAppData, 'Codex', 'Logs') },
    { kind: 'msix', path: path.join(localAppData, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0',
      'LocalCache', 'Local', 'Codex', 'Logs') },
  ];
  if (validRoot(appData)) {
    roots.push({ kind: 'roaming', path: path.join(appData, 'Codex', 'Logs') });
  }
  try {
    const packages = cache
      ? (await cache.read(path.join(localAppData, 'Packages'), now)) ?? []
      : await fs.readdir(path.join(localAppData, 'Packages'), { withFileTypes: true });
    const matching = packages.filter(entry => entry.isDirectory() && PACKAGE.test(entry.name))
      .slice(0, MAX_PACKAGE_NAMES);
    for (const entry of matching) roots.push({
      kind: 'msix', path: path.join(localAppData, 'Packages', entry.name,
        'LocalCache', 'Local', 'Codex', 'Logs'),
    });
  } catch { /* A standalone Codex installation has no required Packages root. */ }
  const unique = new Set();
  return roots.filter(root => {
    const identity = key(root.path);
    if (unique.has(identity)) return false;
    unique.add(identity);
    return true;
  }).slice(0, MAX_ROOTS);
}

function dailyFolders(root, now) {
  const directories = [root];
  for (const offset of DAY_OFFSETS) {
    const day = new Date(now + offset * 86_400_000);
    directories.push(path.join(root, String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0')));
  }
  return [...new Set(directories)];
}

/** Stats are privacy-safe diagnostics: categories and COUNTS only, not paths.
 * Candidate filenames are returned only to the trusted in-process log reader.
 */
export async function discoverDesktopLogFiles(localAppData, now = Date.now(),
  appData = process.env.APPDATA ?? '', cache = null) {
  const roots = await desktopLogRoots(localAppData, appData, cache, now);
  const result = {
    validLocalAppData: validRoot(localAppData),
    roots: [],
    files: [],
  };
  const candidates = [];
  for (const root of roots) {
    const stats = { kind: root.kind, exists: false, accessibleDateFolders: 0,
      anyLogFiles: 0, matchedNames: 0, recentCandidates: 0 };
    try { stats.exists = (await fs.stat(root.path)).isDirectory(); }
    catch { /* Missing root is a valid diagnostic outcome. */ }
    for (const directory of dailyFolders(root.path, now)) {
      let entries;
      if (cache) entries = await cache.read(directory, now);
      else {
        try { entries = await fs.readdir(directory, { withFileTypes: true }); }
        catch { entries = null; }
      }
      if (!entries) continue;
      stats.accessibleDateFolders++;
      // Filter file kinds BEFORE bounding the work. A directory containing
      // hundreds of unrelated files must not hide a valid recent Codex log.
      const logEntries = entries.filter(entry => entry.isFile() && /\.log$/i.test(entry.name))
        .slice(0, MAX_ENTRIES_PER_DIRECTORY);
      for (const entry of logEntries) {
        stats.anyLogFiles++;
        if (!LOG_FILENAME.test(entry.name)) continue;
        stats.matchedNames++;
        try {
          const absolute = path.join(directory, entry.name);
          const stat = await fs.stat(absolute);
          if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LOG_SIZE ||
              stat.mtimeMs < now - MAX_AGE_MS || stat.mtimeMs > now + 60_000) continue;
          stats.recentCandidates++;
          candidates.push({ path: absolute, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch { /* Live rotation, removal, or ACL: skip only this file. */ }
      }
    }
    result.roots.push(stats);
  }
  const seen = new Set();
  for (const candidate of candidates.sort((a,b) => b.mtimeMs - a.mtimeMs)) {
    const id = key(candidate.path);
    if (seen.has(id)) continue;
    seen.add(id);
    result.files.push(candidate);
    if (result.files.length >= MAX_FILES) break;
  }
  return result;
}
