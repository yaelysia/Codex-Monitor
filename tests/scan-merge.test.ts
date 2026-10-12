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
