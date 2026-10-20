import { describe, expect, it, vi } from 'vitest';
import { RemoteScanCache } from '../electron/remote-scan-cache';
import { normalizeRemote } from '../electron/collector';

const NOW = 1_800_000_000_000, ROOT = 'a'.repeat(64);
const PATH = '2026/10/19/rollout-one.jsonl', SOURCE = 'ssh:one';
const normalize = (rows: unknown) => normalizeRemote(rows, SOURCE, 'remote');
const directory = (modified = NOW - 1000) => ({
  rootKey: ROOT, count: 10000, files: [{ path: PATH, modified, order: 7 }],
});
const fresh = (modified = NOW - 1000) => ({
  id: 'one', rolloutPath: PATH, updatedAt: modified, byteSize: 20,
  status: 'finished', statusReason: 'done', clientKind: 'terminal',
});
const envelope = (directoryData: unknown = directory(), mode = 'full') => ({
  version: 1, rootKey: ROOT, sourceNow: NOW,
  sessions: [fresh()], directory: directoryData,
  metrics: { indexMode: mode, indexedFiles: 10000,
    directoriesEnumerated: mode === 'full' ? 5 : 0,
    statCalls: mode === 'full' ? 10000 : 200, parsedFiles: 1, cacheHits: 0 },
});
async function run(cache: RemoteScanCache, full = false) {
  const spy = vi.fn(async (request: Record<string, unknown>) =>
    envelope(directory(), request.directory ? 'incremental' : 'full'));
  const data = await cache.read(SOURCE, 'host', !full, spy, normalize);
  return { request: spy.mock.calls[0]![0] as Record<string, unknown>, data };
}
describe('source-scoped remote candidate index safety', () => {
  it('requires watcher readiness and a post-ready full baseline before sending a shortlist', async () => {
    const cache = new RemoteScanCache();
    expect((await run(cache)).request).not.toHaveProperty('directory');
    cache.noteWatch(SOURCE, { kind: 'ready' });
    expect((await run(cache)).request).not.toHaveProperty('directory');
    const incremental = await run(cache);
    expect(incremental.request).toHaveProperty('directory');
    expect(incremental.data.metrics).toMatchObject({ indexMode: 'incremental',
      directoriesEnumerated: 0, statCalls: 200 });
  });
  it('keeps known append paths incremental, invalidates new/removed paths or watcher gaps', async () => {
    const cache = new RemoteScanCache();
    await run(cache); cache.noteWatch(SOURCE, { kind: 'ready' }); await run(cache);
    cache.noteWatch(SOURCE, { kind: 'change', paths: [PATH] });
    expect((await run(cache)).request).toHaveProperty('directory');
    cache.noteWatch(SOURCE, { kind: 'change', paths: ['2026/10/19/rollout-new.jsonl'] });
    expect((await run(cache)).request).not.toHaveProperty('directory');
    expect((await run(cache)).request).toHaveProperty('directory');
    cache.noteWatch(SOURCE, { kind: 'lost' });
    expect((await run(cache)).request).not.toHaveProperty('directory');
    cache.noteWatch(SOURCE, { kind: 'ready' }); await run(cache);
    expect((await run(cache)).request).toHaveProperty('directory');
    cache.noteWatch(SOURCE, { kind: 'change', reset: true, paths: [PATH] });
    expect((await run(cache)).request).not.toHaveProperty('directory');
  });
  it('never promotes another source, replaced connection, or expired audit deadline', async () => {
    const cache = new RemoteScanCache();
    await run(cache); cache.noteWatch(SOURCE, { kind: 'ready' }); await run(cache);
    const other = vi.fn(async (_request: Record<string, unknown>) => envelope());
    await cache.read('wsl:Ubuntu', 'host', true, other, rows =>
      normalizeRemote(rows, 'wsl:Ubuntu', 'Ubuntu'));
    expect(other.mock.calls[0]![0]).not.toHaveProperty('directory');
    const changedTransport = vi.fn(async (_request: Record<string, unknown>) => envelope());
    await cache.read(SOURCE, 'another-host', true, changedTransport, normalize);
    expect(changedTransport.mock.calls[0]![0]).not.toHaveProperty('directory');
  });
  it('rejects untrusted candidate metadata and does not trust stale concurrent scans', async () => {
    for (const index of [
      { ...directory(), files: [{ ...directory().files[0], path: '../../escape' }] },
      { ...directory(), files: [directory().files[0], directory().files[0]] },
      { ...directory(), count: 10001 },
    ]) {
      const cache = new RemoteScanCache();
      await run(cache); cache.noteWatch(SOURCE, { kind: 'ready' });
      await cache.read(SOURCE, 'host', true, async () => envelope(index), normalize);
      expect((await run(cache)).request).not.toHaveProperty('directory');
    }
    const cache = new RemoteScanCache();
    await run(cache); cache.noteWatch(SOURCE, { kind: 'ready' }); await run(cache);
    let done!: (value: unknown) => void;
    const pending = cache.read(SOURCE, 'host', true,
      () => new Promise(resolve => { done = resolve; }), normalize);
    cache.noteWatch(SOURCE, { kind: 'change', paths: [PATH] });
    done(envelope());
    await pending;
    expect((await run(cache)).request).not.toHaveProperty('directory');
  });
});
