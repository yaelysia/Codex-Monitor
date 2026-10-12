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

/** Prefer both the canonical Store package and dynamically discovered package
 * identities. In particular, never slice Package directory entries BEFORE
 * filtering for Codex: directories are not guaranteed to be alphabetic.
 */
export async function desktopLogRoots(localAppData, appData = process.env.APPDATA ?? '') {
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
    const packages = await fs.readdir(path.join(localAppData, 'Packages'), { withFileTypes: true });
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
  appData = process.env.APPDATA ?? '') {
  const roots = await desktopLogRoots(localAppData, appData);
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
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch { continue; }
      stats.accessibleDateFolders++;
      for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIRECTORY)) {
        if (!entry.isFile()) continue;
        if (!/\.log$/i.test(entry.name)) continue;
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
