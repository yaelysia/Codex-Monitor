import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemoteScanCache } from '../electron/remote-scan-cache';
import { normalizeRemote } from '../electron/collector';

const NOW = 1_800_000_000_000;
const script = readFileSync(new URL('../collector/scan.py', import.meta.url), 'utf8');
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'monitor-wire-'));
  temporary.push(directory);
  const day = path.join(directory, 'sessions', '2026', '10', '19');
  mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-one.jsonl');
  writeFileSync(file, [
    { type: 'session_meta', payload: { id: 'one', source: 'cli', cwd: '/project' } },
    { type: 'event_msg', timestamp: new Date(NOW - 2000).toISOString(), payload: { type: 'user_message', message: 'original title' } },
    { type: 'event_msg', payload: { type: 'turn_started', turn_id: 'a' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  utimesSync(file, new Date(NOW - 1000), new Date(NOW - 1000));
  return directory;
}
function invoke(directory: string, now: number, scanCache?: Record<string, unknown>): unknown {
  const config = Buffer.from(JSON.stringify({ root: directory, scanCache }), 'utf8').toString('base64');
  // Execute exactly the standalone stdin deployment, with a controlled SOURCE clock.
  const input = `CONFIG_B64 = '${config}'\nimport time\ntime.time = lambda: ${now / 1000}\n` + script;
  return JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-'], {
    input, encoding: 'utf8', timeout: 10000, cwd: directory, windowsHide: true,
    // Match the remote UTF-8 wire encoding when the CI interpreter runs on Windows.
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  }));
}

describe('real Python stdin -> TypeScript remote-cache protocol', () => {
  it.each(['ssh:host', 'wsl:Ubuntu'])('hydrates %s identically to a fresh scan and expires working evidence', async source => {
    const directory = root(), cache = new RemoteScanCache();
    const normalize = (rows: unknown) => normalizeRemote(rows, source, source);
    const read = (now: number, reuse = true) => cache.read(source, directory, reuse,
      async hints => invoke(directory, now, hints), normalize);
    await read(NOW);
    writeFileSync(path.join(directory, 'session_index.jsonl'), JSON.stringify({ id: 'one', thread_name: 'renamed title' }));
    const warm = await read(NOW + 3000);
    expect(warm.metrics?.cacheHits).toBe(1);
    expect(warm.sessions).toEqual(normalize(invoke(directory, NOW + 3000)));
    expect(warm.sessions[0]!.title).toBe('renamed title');
    const forced = await read(NOW + 4000, false);
    expect(forced.metrics?.cacheHits).toBe(0);
    // Renew near the age boundary, then cross it without a single new file byte.
    await read(NOW + 88000);
    const expired = await read(NOW + 89001);
    expect(expired.metrics?.parsedFiles).toBe(1);
    expect(expired.sessions).toEqual(normalize(invoke(directory, NOW + 89001)));
    expect(expired.sessions[0]!.status).toBe('unknown');
  });
});


describe('actual Python stdin incremental directory index', () => {
  it.each(['ssh:host', 'wsl:Ubuntu'])('%s skips directory walk after watcher readiness; reset restores exact full selection', async source => {
    const directory = root(), cache = new RemoteScanCache();
    const normalize = (rows: unknown) => normalizeRemote(rows, source, source);
    const read = (now: number, reuse = true) => cache.read(source, directory, reuse,
      async hints => invoke(directory, now, hints), normalize);
    const initial = await read(NOW);
    expect(initial.metrics?.indexMode).toBe('full');
    cache.noteWatch(source, { kind: 'ready' });
    const baseline = await read(NOW + 1000);
    expect(baseline.metrics?.indexMode).toBe('full');

    // An append to a shortlisted file is safe; inspect only the shortlist.
    const file = path.join(directory, 'sessions', '2026', '10', '19', 'rollout-one.jsonl');
    writeFileSync(file, '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'turn_complete', turn_id: 'a' } }), { flag: 'a' });
    utimesSync(file, new Date(NOW + 1200), new Date(NOW + 1200));
    cache.noteWatch(source, { kind: 'change', paths: ['2026/10/19/rollout-one.jsonl'] });
    const indexed = await read(NOW + 2000);
    expect(indexed.metrics).toMatchObject({ indexMode: 'incremental', directoriesEnumerated: 0 });
    expect(indexed.sessions).toEqual(normalize(invoke(directory, NOW + 2000)));
    // A newly-created rollout (or a deletion / rename) must rebuild the
    // selection; it cannot remain invisible behind a stale top-200 index.
    const other = path.join(directory, 'sessions', '2026', '10', '19', 'rollout-new.jsonl');
    writeFileSync(other, [
      { type: 'session_meta', payload: { id: 'new', source: 'cli' } },
      { type: 'event_msg', payload: { type: 'turn_complete', turn_id: 'b' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    utimesSync(other, new Date(NOW + 2100), new Date(NOW + 2100));
    cache.noteWatch(source, { kind: 'change', reset: true, paths: [] });
    const recovered = await read(NOW + 3000);
    expect(recovered.metrics?.indexMode).toBe('full');
    expect(recovered.sessions.map(row => row.id)).toContain('new');
  });
});
