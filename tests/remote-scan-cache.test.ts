import { describe, expect, it, vi } from 'vitest';
import { RemoteScanCache } from '../electron/remote-scan-cache';
import { normalizeRemote } from '../electron/collector';

const NOW = 1_800_000_000_000;
const ROOT = 'a'.repeat(64);
const PATH = '2026/10/19/rollout-one.jsonl';
const normalize = (rows: unknown) => normalizeRemote(rows, 'ssh:one', 'Server');
const fresh = (changes: Record<string, unknown> = {}) => ({
  id: 'one', rolloutPath: PATH, updatedAt: NOW - 1000, byteSize: 100,
  ageAtSourceMs: 1000, lastUserInputAtSourceMs: NOW - 2000, lastUserInputAgeAtSourceMs: 2000,
  title: 'enriched title', workspace: '/private-workspace', clientKind: 'terminal',
  status: 'working', statusReason: 'log evidence', interruptionTokens: ['old-abort'],
  _cache: { signature: '1:2:100:123:456:33188', from: NOW, until: NOW + 60000,
    title: 'original title', clientKind: 'terminal' }, ...changes,
});
const reference = (changes: Record<string, unknown> = {}) => ({
  id: 'one', rolloutPath: PATH, updatedAt: NOW - 1000, byteSize: 100,
  _reuse: fresh()._cache.signature, title: null, clientKind: 'unknown', ...changes,
});
const envelope = (sessions: unknown[], now = NOW, rootKey = ROOT) => ({
  version: 1, rootKey, sourceNow: now, sessions,
  metrics: { indexedFiles: 10000, statCalls: 10000, parsedFiles: 1, cacheHits: 0 },
});
async function prime(cache: RemoteScanCache, row = fresh(), id = 'ssh:one', identity = 'host-one') {
  return cache.read(id, identity, true, async () => envelope([row]), normalize);
}

describe('remote parse references are scoped, bounded and age-safe', () => {
  it('sends only locator/signature metadata and preserves raw parses before downstream projection', async () => {
    const cache = new RemoteScanCache();
    const first = await prime(cache);
    first.sessions[0]!.status = 'finished';
    first.sessions[0]!.evidenceKind = 'retained-activity';
    first.sessions[0]!.interruptionTokens!.push('must-not-leak');
    const run = vi.fn(async (_request: Record<string, unknown>) => envelope([reference()], NOW + 3000));
    const result = await cache.read('ssh:one', 'host-one', true, run, normalize);
    expect(result.sessions[0]).toMatchObject({ status: 'working', title: 'original title',
      ageAtSourceMs: 4000, lastUserInputAgeAtSourceMs: 5000, interruptionTokens: ['old-abort'] });
    expect(result.sessions[0]!.evidenceKind).toBeUndefined();
    const request = run.mock.calls[0]![0];
    expect(request).toEqual({ version: 1, rootKey: ROOT, entries: [{ path: PATH, id: 'one',
      signature: fresh()._cache.signature, from: NOW, until: NOW + 60000 }] });
    expect(JSON.stringify(request)).not.toMatch(/private-workspace|title|status|old-abort/);
    expect(result.metrics).toMatchObject({ indexMode: 'full', indexedFiles: 10000, statCalls: 10000 });
  });

  it('refreshes enriched titles/client origin and falls back to the original header after deletion', async () => {
    const cache = new RemoteScanCache();
    await prime(cache, fresh({ clientKind: 'desktop', _cache: { ...fresh()._cache, clientKind: 'unknown' } }));
    let result = await cache.read('ssh:one', 'host-one', true,
      async () => envelope([reference({ title: 'new name', clientKind: 'vscode' })], NOW + 1000), normalize);
    expect(result.sessions[0]).toMatchObject({ title: 'new name', clientKind: 'vscode' });
    result = await cache.read('ssh:one', 'host-one', true,
      async () => envelope([reference()], NOW + 2000), normalize);
    expect(result.sessions[0]).toMatchObject({ title: 'original title', clientKind: 'unknown' });
  });

  it('does not slide expiry, and rejects expired or clock-rollback references', async () => {
    for (const invalidNow of [NOW - 1, NOW + 60000]) {
      const cache = new RemoteScanCache(); await prime(cache);
      await cache.read('ssh:one', 'host-one', true,
        async () => envelope([reference()], NOW + 59000), normalize);
      await expect(cache.read('ssh:one', 'host-one', true,
        async () => envelope([reference()], invalidNow), normalize)).rejects.toThrow('Unmatched');
      const run = vi.fn(async (_request: Record<string, unknown>) => envelope([fresh()]));
      await cache.read('ssh:one', 'host-one', true, run, normalize);
      expect(run.mock.calls[0]![0].entries).toEqual([]);
    }
  });

  it('does not reuse on full scans, changed transport/root settings or another source', async () => {
    for (const [id, identity, reuse] of [
      ['ssh:one', 'host-one', false], ['ssh:one', 'host-two', true], ['wsl:Ubuntu', 'host-one', true],
    ] as const) {
      const cache = new RemoteScanCache(); await prime(cache);
      const run = vi.fn(async (_request: Record<string, unknown>) => envelope([fresh()]));
      await cache.read(id, identity, reuse, run, rows => normalizeRemote(rows, id, 'New label'));
      expect(run.mock.calls[0]![0].entries).toEqual([]);
    }
  });

  it('fails closed on unmatched path, ID, signature, size, timestamp and real-root digest', async () => {
    for (const override of [{ id: 'other' }, { rolloutPath: '2026/10/19/other.jsonl' },
      { _reuse: 'other' }, { byteSize: 101 }, { updatedAt: NOW }]) {
      const cache = new RemoteScanCache(); await prime(cache);
      await expect(cache.read('ssh:one', 'host-one', true,
        async () => envelope([reference(override)], NOW + 1000), normalize)).rejects.toThrow('Unmatched');
    }
    const cache = new RemoteScanCache(); await prime(cache);
    await expect(cache.read('ssh:one', 'host-one', true,
      async () => envelope([reference()], NOW + 1000, 'b'.repeat(64)), normalize)).rejects.toThrow('Unmatched');
  });

  it('drops reuse after a source failure and keeps the legacy array protocol working', async () => {
    const cache = new RemoteScanCache(); await prime(cache);
    await expect(cache.read('ssh:one', 'host-one', true,
      async () => { throw new Error('offline'); }, normalize)).rejects.toThrow('offline');
    const run = vi.fn(async (_request: Record<string, unknown>) => [fresh()]);
    const result = await cache.read('ssh:one', 'host-one', true, run, normalize);
    expect(run.mock.calls[0]![0].entries).toEqual([]);
    expect(result.metrics).toBeUndefined(); expect(result.sessions).toEqual(normalize([fresh()]));
    await cache.read('ssh:one', 'host-one', true, run, normalize);
    expect(run.mock.calls[1]![0].entries).toEqual([]);
  });

  it('replaces the cached set rather than resurrecting deleted/unselected sessions', async () => {
    const cache = new RemoteScanCache(); await prime(cache);
    await cache.read('ssh:one', 'host-one', true, async () => envelope([], NOW + 1000), normalize);
    const run = vi.fn(async (_request: Record<string, unknown>) => envelope([]));
    await cache.read('ssh:one', 'host-one', true, run, normalize);
    expect(run.mock.calls[0]![0].entries).toEqual([]);
  });

  it('ignores malformed cache stamps without discarding a valid fresh session', async () => {
    for (const bad of [null, { ...fresh()._cache, until: NOW + 60001 },
      { ...fresh()._cache, from: true }, { ...fresh()._cache, signature: '' }]) {
      const cache = new RemoteScanCache();
      expect((await prime(cache, fresh({ _cache: bad }))).sessions).toHaveLength(1);
      const run = vi.fn(async (_request: Record<string, unknown>) => envelope([]));
      await cache.read('ssh:one', 'host-one', true, run, normalize);
      expect(run.mock.calls[0]![0].entries).toEqual([]);
    }
  });

  it('bounds source count, row count and serialized metadata rather than caching transcripts', async () => {
    const cache = new RemoteScanCache();
    for (let i = 0; i < 9; i++) await prime(cache, fresh(), 'ssh:' + i);
    const run = vi.fn(async (_request: Record<string, unknown>) => envelope([]));
    await cache.read('ssh:0', 'host-one', true, run, normalize);
    expect(run.mock.calls[0]![0].entries).toEqual([]);
    const rows = Array.from({ length: 216 }, (_, i) => fresh({ id: 'id-' + i,
      rolloutPath: '2026/10/19/' + i + '.jsonl', statusReason: 'X'.repeat(10000) }));
    await cache.read('ssh:wide', 'host-one', false, async () => envelope(rows), normalize);
    const wide = vi.fn(async (_request: Record<string, unknown>) => envelope([]));
    await cache.read('ssh:wide', 'host-one', true, wide, normalize);
    expect((wide.mock.calls[0]![0].entries as unknown[]).length).toBeLessThan(53);
    await expect(cache.read('ssh:wide', 'host-one', false,
      async () => envelope([...rows, fresh()]), normalize)).rejects.toThrow('Invalid conditional');
  });

  it('a late concurrent request cannot replace a newer cache generation', async () => {
    const cache = new RemoteScanCache();
    let finish!: (value: unknown) => void;
    const pending = cache.read('ssh:one', 'host-one', true,
      () => new Promise(resolve => { finish = resolve; }), normalize);
    await prime(cache, fresh({ _cache: { ...fresh()._cache, signature: 'newest' } }));
    finish(envelope([fresh()])); await pending;
    const run = vi.fn(async (_request: Record<string, unknown>) => envelope([]));
    await cache.read('ssh:one', 'host-one', true, run, normalize);
    expect(run.mock.calls[0]![0].entries).toEqual([expect.objectContaining({ signature: 'newest' })]);
  });
});
