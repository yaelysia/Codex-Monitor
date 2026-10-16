import fs from 'node:fs/promises';
import path from 'node:path';
import { validPinnedRolloutPath } from '../src/shared/pinned-rollouts';

const MAX_DISCOVERED = 10_000;
/** Bulk changes are cheaper to sort once; normal watcher events touch 1-2 files. */
const INCREMENTAL_REORDER_LIMIT = 32;
function newerFirst(a: RolloutFileStat, b: RolloutFileStat): number {
  const delta = b.mtime - a.mtime;
  // Stable deterministic tie-break makes full and incremental ordering agree.
  return delta || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}
const MAX_INDEX_ROOTS = 6;
const MAX_DIRTY_PATHS = 512;
export const INDEX_REDISCOVERY_MS = 60_000;

export interface RolloutFileStat { file: string; mtime: number; size: number }
export interface LocalFileIndexMetrics {
  mode: 'full' | 'incremental';
  indexedFiles: number;
  statCalls: number;
  changedPaths: number;
  /** Total full sort/rebuilds since index creation (for regression diagnostics). */
  sortRebuilds: number;
}

export async function mapLimited<T, R>(
  items: readonly T[], limit: number, mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      result[index] = await mapper(items[index]!);
    }
  }));
  return result;
}

async function findRollouts(dir: string, remaining: {count: number}, depth = 0): Promise<string[]> {
  if (depth > 5 || remaining.count <= 0) return [];
  const entries = await fs.readdir(dir, {withFileTypes:true});
  entries.sort((a,b) => b.name.localeCompare(a.name));
  const files: string[] = [];
  for (const entry of entries) {
    if (remaining.count <= 0) break;
    const current = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await findRollouts(current, remaining, depth + 1));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(current);
      remaining.count--;
    }
  }
  return files;
}

async function statRollout(file: string): Promise<RolloutFileStat | null> {
  try {
    // Unlike stat(), lstat() refuses an event-supplied symlink out of sessions.
    const stat = await fs.lstat(file);
    return stat.isFile() ? {file, mtime:stat.mtimeMs, size:stat.size} : null;
  } catch { return null; }
}

export class LocalFileIndex {
  private entries = new Map<string, RolloutFileStat>();
  /** Sorted once on full discovery; selectively reposition on file events. */
  private ordered: RolloutFileStat[] = [];
  private sortRebuilds = 0;
  private dirty = new Set<string>();
  private fullAt = 0;
  private ready = false;
  private invalidated = false;
  private latest: LocalFileIndexMetrics =
    {mode:'full',indexedFiles:0,statCalls:0,changedPaths:0,sortRebuilds:0};

  /** File names only; unknown names, directory renames and missing watcher
   * evidence force a full discovery. No paths leave the local process.
   */
  note(sessionsDir: string, name?: string | null): void {
    const relative = name?.replace(/\\/g, '/');
    if (!validPinnedRolloutPath(relative)) {
      this.invalidated = true;
      return;
    }
    this.dirty.add(path.resolve(sessionsDir, ...relative.split('/')));
    if (this.dirty.size > MAX_DIRTY_PATHS) {
      this.dirty.clear();
      this.invalidated = true;
    }
  }

  diagnostics(): LocalFileIndexMetrics { return {...this.latest}; }

  private rebuildOrder(): void {
    this.ordered = [...this.entries.values()].sort(newerFirst);
    this.sortRebuilds++;
  }

  private updateOrder(file: string, record: RolloutFileStat | null): void {
    const index = this.ordered.findIndex(entry => entry.file === file);
    if (index >= 0) this.ordered.splice(index, 1);
    if (!record) {
      this.entries.delete(file);
      return;
    }
    this.entries.set(file, record);
    let start = 0, end = this.ordered.length;
    while (start < end) {
      const mid = (start + end) >>> 1;
      if (newerFirst(record, this.ordered[mid]!) < 0) end = mid;
      else start = mid + 1;
    }
    this.ordered.splice(start, 0, record);
  }

  async candidates(sessionsDir: string, now: number, useIncremental: boolean): Promise<RolloutFileStat[]> {
    const full = !useIncremental || !this.ready || this.invalidated ||
      now < this.fullAt || now - this.fullAt >= INDEX_REDISCOVERY_MS;
    const changed = [...this.dirty];
    this.dirty.clear();
    this.invalidated = false;
    let statCalls = 0;
    if (full) {
      const files = await findRollouts(sessionsDir, {count:MAX_DISCOVERED});
      statCalls = files.length;
      const records = await mapLimited(files, 24, statRollout);
      this.entries = new Map(records.filter((r):r is RolloutFileStat=>!!r)
        .map(row => [row.file,row]));
      this.rebuildOrder();
      this.fullAt = now;
      this.ready = true;
      // Changes which arrived while discovery was running remain queued.
    } else if (changed.length) {
      // No dirty files means no realpath/stat I/O and no full-array sort.
      statCalls = changed.length;
      const realRoot = await fs.realpath(sessionsDir);
      const records = await mapLimited(changed, 24, async file => {
        // An event can name a regular file inside a symlinked date folder.
        // lstat(file) checks only the leaf, not its parent directories.
        const actual = await fs.realpath(file).catch(() => null);
        if (!actual) return null;
        const rel = path.relative(realRoot, actual);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
        return statRollout(file);
      });
      if (changed.length > INCREMENTAL_REORDER_LIMIT) {
        for (let i = 0; i < changed.length; i++) {
          const row = records[i];
          if (row) this.entries.set(row.file, row);
          else this.entries.delete(changed[i]!);
        }
        this.rebuildOrder();
      } else {
        for (let i = 0; i < changed.length; i++) {
          this.updateOrder(changed[i]!, records[i] ?? null);
        }
      }
    }
    if (this.ordered.length > MAX_DISCOVERED) {
      this.ordered.length = MAX_DISCOVERED;
      this.entries = new Map(this.ordered.map(row => [row.file, row]));
    }
    this.latest = {mode:full?'full':'incremental',
      indexedFiles:this.entries.size,statCalls,changedPaths:changed.length,
      sortRebuilds:this.sortRebuilds};
    return this.ordered.slice();
  }
}

// The resident Windows Monitor normally uses one CODEX_HOME. Bound the
// number of distinct roots when users change configuration or tests use tmpdirs.
const indices = new Map<string,LocalFileIndex>();
function getIndex(root: string): LocalFileIndex {
  const key = path.resolve(root);
  let index = indices.get(key);
  if (!index) {
    index = new LocalFileIndex();
    indices.set(key,index);
    if (indices.size > MAX_INDEX_ROOTS) indices.delete(indices.keys().next().value!);
  }
  return index;
}
export function noteLocalRolloutChange(root: string, relative?: string | null): void {
  getIndex(path.join(root,'sessions')).note(path.join(root,'sessions'),relative);
}
export function localFileIndexDiagnostics(root: string): LocalFileIndexMetrics {
  return getIndex(path.join(root,'sessions')).diagnostics();
}
export async function indexedRollouts(root: string, now: number, useIncremental: boolean):
  Promise<RolloutFileStat[]> {
  return getIndex(path.join(root,'sessions')).candidates(path.join(root,'sessions'),now,useIncremental);
}
