import type { SessionClientKind, SessionRecord, SourceScanMetrics } from '../src/shared/types';
import { validPinnedRolloutPath } from '../src/shared/pinned-rollouts';

const MAX_SOURCES = 8;
const MAX_ROWS = 216;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_CACHE_MS = 60_000;
const DIGEST = /^[0-9a-f]{64}$/;
type Row = Record<string, unknown>;
type ParseStamp = {
  signature: string; from: number; until: number;
  title: string | null; clientKind: SessionClientKind;
};
type Cached = { session: SessionRecord; stamp: ParseStamp };
type Slot = { identity: string; rootKey: string; rows: Map<string, Cached>; lease: object };
export type RemoteScanResult = { sessions: SessionRecord[]; metrics?: Partial<SourceScanMetrics> };
const object = (value: unknown): Row | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const clientKind = (value: unknown): value is SessionClientKind =>
  value === 'desktop' || value === 'vscode' || value === 'terminal' || value === 'unknown';
function stamp(value: unknown, now: number): ParseStamp | null {
  const row = object(value);
  if (!row || typeof row.signature !== 'string' || !row.signature.length || row.signature.length > 256 ||
      !integer(row.from) || !integer(row.until) || row.from <= 0 || row.from > now || now >= row.until ||
      row.until - row.from > MAX_CACHE_MS || !clientKind(row.clientKind) ||
      (row.title !== null && (typeof row.title !== 'string' || row.title.length > 181))) return null;
  return { signature: row.signature, from: row.from, until: row.until,
    title: row.title, clientKind: row.clientKind };
}
const copy = (row: SessionRecord): SessionRecord => ({ ...row,
  interruptionTokens: row.interruptionTokens?.slice(), failureTokens: row.failureTokens?.slice() });

/** Bounded, memory-only parse reuse. The remote process retains no state and
 * receives only relative locators, IDs, stat signatures and expiry timestamps.
 * Never cache activity/native projections or feed source errors back as live rows.
 */
export class RemoteScanCache {
  private slots = new Map<string, Slot>();

  async read(sourceId: string, identity: string, reuse: boolean,
    run: (request: Record<string, unknown>) => Promise<unknown>,
    normalize: (rows: unknown) => SessionRecord[]): Promise<RemoteScanResult> {
    let slot = this.slots.get(sourceId);
    if (!slot || slot.identity !== identity) {
      slot = { identity, rootKey: '', rows: new Map(), lease: {} };
    }
    this.slots.delete(sourceId);
    this.slots.set(sourceId, slot);
    while (this.slots.size > MAX_SOURCES) this.slots.delete(this.slots.keys().next().value!);
    const lease = slot.lease = {};
    const before = reuse ? slot.rows : new Map<string, Cached>();
    const rootKey = slot.rootKey;
    const current = () => this.slots.get(sourceId) === slot && slot.lease === lease;
    try {
      const response = await run({ version: 1, rootKey, entries: [...before].map(([path, entry]) => ({
        path, id: entry.session.id, signature: entry.stamp.signature,
        from: entry.stamp.from, until: entry.stamp.until,
      })) });
      // Legacy collector/mock compatibility: absence of reuse metadata means no caching.
      if (Array.isArray(response)) {
        if (current()) { slot.rows = new Map(); slot.rootKey = ''; }
        return { sessions: normalize(response) };
      }
      const envelope = object(response);
      if (!envelope || envelope.version !== 1 || typeof envelope.rootKey !== 'string' ||
          !DIGEST.test(envelope.rootKey) || !integer(envelope.sourceNow) || envelope.sourceNow <= 0 ||
          !Array.isArray(envelope.sessions) || envelope.sessions.length > MAX_ROWS) {
        throw new Error('Invalid conditional scanner response');
      }
      const now = envelope.sourceNow, sessions: SessionRecord[] = [];
      const next = new Map<string, Cached>();
      let bytes = 0;
      for (const value of envelope.sessions) {
        const row = object(value);
        if (!row) throw new Error('Invalid conditional scanner row');
        const path = row.rolloutPath;
        let metadata: ParseStamp | null, item: SessionRecord | undefined;
        if (row._reuse !== undefined) {
          const cached = typeof path === 'string' ? before.get(path) : undefined;
          if (!cached || envelope.rootKey !== rootKey || row.id !== cached.session.id ||
              row._reuse !== cached.stamp.signature || row.updatedAt !== cached.session.updatedAt ||
              row.byteSize !== cached.session.byteSize || !(metadata = stamp(cached.stamp, now))) {
            throw new Error('Unmatched conditional scanner reference');
          }
          const inputAt = cached.session.lastUserInputAtSourceMs;
          [item] = normalize([{ ...copy(cached.session),
            title: row.title ?? metadata.title,
            clientKind: metadata.clientKind === 'unknown' ? row.clientKind : metadata.clientKind,
            ageAtSourceMs: now - cached.session.updatedAt,
            lastUserInputAgeAtSourceMs: inputAt == null ? null : now - inputAt,
          }]);
        } else {
          [item] = normalize([row]);
          metadata = stamp(row._cache, now);
        }
        if (!item) throw new Error('Invalid conditional scanner session');
        sessions.push(item);
        if (!metadata || !validPinnedRolloutPath(path) || item.id.length > 128) continue;
        const entry = { session: copy(item), stamp: metadata };
        const cost = Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (bytes + cost > MAX_SOURCE_BYTES) continue;
        bytes += cost;
        next.set(path, entry);
      }
      if (current()) { slot.rows = next; slot.rootKey = envelope.rootKey; }
      const rawMetrics = object(envelope.metrics);
      const metrics: Partial<SourceScanMetrics> = { indexMode: 'full' };
      for (const key of ['indexedFiles', 'statCalls', 'parsedFiles', 'cacheHits'] as const) {
        const count = rawMetrics?.[key];
        if (integer(count) && count >= 0) metrics[key] = count;
      }
      return { sessions, metrics };
    } catch (error) {
      if (current()) { slot.rows = new Map(); slot.rootKey = ''; }
      throw error;
    }
  }
}
