import type { ScanResponse } from './types';

/** Combine one or more event-rescanned hosts with cached unaffected hosts.
 * Only the fresh delta should be fed to AlertTracker before this merge. */
export function mergeSourceSnapshots(
  previous: ScanResponse, delta: ScanResponse,
): ScanResponse {
  const updates = new Map(delta.sources.map(source => [source.id, source]));
  const known = new Set(previous.sources.map(source => source.id));
  return {
    scannedAt: delta.scannedAt,
    sources: [
      ...previous.sources.map(source => updates.get(source.id) ?? source),
      ...delta.sources.filter(source => !known.has(source.id)),
    ],
  };
}
