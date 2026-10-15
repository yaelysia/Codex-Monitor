import { describe, expect, it } from 'vitest';
import { mergeSourceSnapshots } from '../src/shared/scan-merge';
import type { ScanResponse, SourceResult } from '../src/shared/types';

const source = (id: string, count: number): SourceResult => ({
  id, label: id, kind: 'ssh', sessions: [], error: count > 0 ? null : 'temporary failure',
});
describe('event-triggered targeted snapshot merge', () => {
  it('updates just the signaled host and preserves untouched sources in order', () => {
    const previous: ScanResponse = {
      scannedAt: 10, sources: [source('local', 1), source('wsl:Ubuntu', 1), source('ssh:one', 1)],
    };
    const target: SourceResult = { ...source('ssh:one', 1), label: 'remote refreshed' };
    const delta: ScanResponse = { scannedAt: 20, sources: [target] };
    const merged = mergeSourceSnapshots(previous, delta);
    expect(merged).toMatchObject({
      scannedAt: 20, sources: [
        { id: 'local' }, { id: 'wsl:Ubuntu' }, { id: 'ssh:one', label: 'remote refreshed' },
      ],
    });
    expect(merged.sources[0]).toBe(previous.sources[0]);
    expect(merged.sources[1]).toBe(previous.sources[1]);
    expect(previous.sources[2]?.label).toBe('ssh:one');
    expect(merged.sources[2]).toBe(target);
  });

  it('keeps failed scans confined to their own source and admits newly configured sources', () => {
    const prior: ScanResponse = { scannedAt: 10, sources: [source('local', 1)] };
    const updated: ScanResponse = {
      scannedAt: 50, sources: [source('ssh:one', 0), source('wsl:Ubuntu', 1)],
    };
    expect(mergeSourceSnapshots(prior, updated).sources.map(src => src.id))
      .toEqual(['local', 'ssh:one', 'wsl:Ubuntu']);
    expect(mergeSourceSnapshots(prior, updated).sources[1]?.error).toBe('temporary failure');
  });
});

describe('retained sources on temporary disconnection', () => {
  const NOW = 1_800_000_000_000;
  const previous: SourceResult = {
    id: 'ssh:one', label: 'Server', kind: 'ssh', error: null,
    sessions: [{
      key: 'ssh:one:active', id: 'active', sourceId: 'ssh:one',
      sourceLabel: 'Server', workspace: '/repo', title: 'Build',
      status: 'working', statusReason: 'previously observed active',
      updatedAt: NOW - 30_000, ageAtSourceMs: 30_000, startedAt: null,
      rolloutPath: '2026/10/12/rollout-active.jsonl',
    }, {
      key: 'ssh:one:done', id: 'done', sourceId: 'ssh:one',
      sourceLabel: 'Server', workspace: '/repo', title: 'Old result',
      status: 'finished', statusReason: 'finished event',
      updatedAt: NOW - 10_000, ageAtSourceMs: 10_000, startedAt: null,
    }],
  };
  const failure: SourceResult = {
    id: 'ssh:one', label: 'Server', kind: 'ssh',
    error: 'SSH disconnected', sessions: [],
  };

  it('retains rows but never advertises stale working/waiting as live', async () => {
    const { SourceRetention } = await import('../src/shared/source-retention');
    const cache = new SourceRetention();
    cache.remember(previous, NOW);
    const stale = cache.onFailure(failure, NOW + 5_000);
    expect(stale).toMatchObject({ error: 'SSH disconnected',
      stale: true, lastHealthyAt: NOW });
    expect(stale.sessions.map(row => row.status)).toEqual(['unknown', 'finished']);
    expect(stale.sessions[0]?.ageAtSourceMs).toBe(35_000);
    expect(stale.sessions[0]?.statusReason).toContain('实时');
    expect(previous.sessions[0]?.status).toBe('working');
    expect(cache.pinSnapshot(NOW + 5_000).sources[0]?.sessions[0]?.status).toBe('working');
  });

  it('does not resurrect long-expired snapshots or store error rows as healthy', async () => {
    const { SourceRetention, SOURCE_RETENTION_MS } =
      await import('../src/shared/source-retention');
    const cache = new SourceRetention();
    cache.remember(previous, NOW);
    expect(cache.onFailure(failure, NOW + SOURCE_RETENTION_MS + 1).sessions).toEqual([]);
    expect(cache.pinSnapshot(NOW + SOURCE_RETENTION_MS + 1).sources).toEqual([]);
    cache.remember(failure, NOW + 1000);
    expect(cache.pinSnapshot(NOW + 1001).sources).toEqual([]);
  });

  it('replaces previous healthy data when the source reconnects', async () => {
    const { SourceRetention } = await import('../src/shared/source-retention');
    const cache = new SourceRetention();
    cache.remember(previous, NOW);
    cache.onFailure(failure, NOW + 1000);
    const resumed = { ...previous, sessions: [{...previous.sessions[0]!,
      status: 'finished' as const, statusReason: 'new completion'}] };
    cache.remember(resumed, NOW + 2000);
    expect(cache.pinSnapshot(NOW + 3000).sources[0]?.sessions[0]?.status).toBe('finished');
    expect(cache.onFailure(failure, NOW + 4000).sessions[0]?.status).toBe('finished');
  });
});
