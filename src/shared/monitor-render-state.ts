import type { MonitorState } from './types';

/** Electron IPC serializes the scan payload into a fresh JS object on every
 * acknowledgement, mute or watcher-channel update. Keep the expensive session
 * tree reference stable until the backend reports a NEW scan revision.
 * Never reuse a newer scan for an older message arriving out of order.
 */
export function keepStableScan(previous: MonitorState, incoming: MonitorState): MonitorState {
  if (!previous.scan || !incoming.scan ||
      previous.scanRevision === undefined || incoming.scanRevision === undefined) {
    return incoming;
  }
  if (incoming.scanRevision < previous.scanRevision) return previous;
  return incoming.scanRevision === previous.scanRevision
    ? { ...incoming, scan: previous.scan }
    : incoming;
}

/** Return the revision to accept, or null if an IPC state only modifies
 * alerts/preferences/performance without new session evidence.
 */
export function nextScanRevision(previous: number | null, incoming: MonitorState): number | null {
  if (!incoming.scan) return null;
  if (incoming.scanRevision === undefined) return previous ?? 0;
  return previous !== null && incoming.scanRevision <= previous
    ? null : incoming.scanRevision;
}
