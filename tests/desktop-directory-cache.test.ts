import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopDirectoryCache, discoverDesktopLogFiles } from '../scripts/desktop-log-discovery.mjs';

const roots: string[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-dir-cache-')); roots.push(d); return d; };
afterEach(() => { for (const d of roots.splice(0)) fs.rmSync(d, { recursive:true, force:true }); });
const folderFor = (root: string, at: number) => {
  const day = new Date(at);
  return path.join(root, 'Codex', 'Logs', String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
};

describe('mtime-invalidation Desktop directory caching', () => {
  it('avoids repeating directory listings while continuing to stat growing files', async () => {
    const root = temp();
    const now = Date.now();
    const folder = folderFor(root, now);
    fs.mkdirSync(folder, {recursive: true});
    const file = path.join(folder, 'codex-desktop-one.log');
    fs.writeFileSync(file, 'first\n');
    const cache = new DesktopDirectoryCache();
    const first = await discoverDesktopLogFiles(root, now, '', cache);
    const stats = cache.stats();
    expect(first.files).toHaveLength(1);
    fs.appendFileSync(file, 'second\n');
    const next = await discoverDesktopLogFiles(root, now + 1000, '', cache);
    expect(cache.stats().cacheHits).toBeGreaterThan(stats.cacheHits);
    expect(cache.stats().enumerations).toBe(stats.enumerations);
    expect(next.files[0]?.size).toBeGreaterThan(first.files[0]!.size);
  });

  it('discovers a new log immediately on directory metadata change', async () => {
    const root = temp();
    const now = Date.now();
    const folder = folderFor(root, now);
    fs.mkdirSync(folder, {recursive: true});
    const cache = new DesktopDirectoryCache();
    expect((await discoverDesktopLogFiles(root, now, '', cache)).files).toHaveLength(0);
    fs.writeFileSync(path.join(folder, 'codex-desktop-new.log'), 'new\n');
    fs.utimesSync(folder, new Date(now+2000), new Date(now+2000));
    const data = await discoverDesktopLogFiles(root, now+3000, '', cache);
    expect(data.files).toHaveLength(1);
  });
});
