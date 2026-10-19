import { AppServerProbeClient, parseProbeEndpoint, type ProbeEndpoint } from '../scripts/app-server-probe/client.mjs';
import { freshNative, isNativeWaiting, nativeFileChangedAt, parseNativeThread, projectNativeScan,
  THREAD_UUID, type NativeConnection, type NativeHealth, type NativeSample, type NativeStatus } from '../src/shared/native-state';
import type { ScanResponse } from '../src/shared/types';

const POLL_MS = 3000, LIST_MS = 10_000, CYCLE_MS = 8000;
const MAX_READS = 64, MAX_TARGETS = 216;
export interface NativeClient {
  closed: boolean;
  stats: { serverRequests: number };
  start(): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
type Factory = (endpoint: ProbeEndpoint) => NativeClient;
type Target = { id: string; key: string; changedAt: number | null };
interface Slot {
  config: NativeConnection; generation: number; client: NativeClient | null;
  timer: ReturnType<typeof setTimeout> | null; deadline: ReturnType<typeof setTimeout> | null;
  polling: boolean; failures: number; cursor: number; listAt: number;
  loaded: Map<string, string>; samples: Map<string, NativeSample>;
  previous: Map<string, NativeStatus>; health: NativeHealth;
}
const signature = (sample: NativeStatus | undefined): string => sample
  ? JSON.stringify([sample.state, sample.flags]) : '';

/** One read-only connection per configured source; never starts or subscribes Codex. */
export class NativeMonitor {
  private configs: NativeConnection[] = [];
  private slots = new Map<string, Slot>();
  private targets = new Map<string, Target[]>();
  private running = false;
  private serial = 0;
  private cachedBase: ScanResponse | null = null;
  private cached: ScanResponse | null = null;
  private cachedRevision = -1;
  revision = 0;

  constructor(private home: string,
    private readonly changed: (waitingKeys: readonly string[]) => void,
    private readonly factory: Factory = endpoint => new AppServerProbeClient(endpoint,
      { timeoutMs: 2000, showIds: true })) {}

  configure(configs: readonly NativeConnection[]): void {
    this.configs = configs.map(config => ({ ...config }));
    for (const [id, slot] of this.slots) {
      const next = this.configs.find(config => config.sourceId === id && config.enabled);
      if (!next || JSON.stringify(next) !== JSON.stringify(slot.config)) {
        this.dispose(slot); this.slots.delete(id);
      }
    }
    this.reconcile(); this.revision++;
  }
  setHome(home: string): void {
    if (this.home === home) return;
    this.home = home;
    for (const [id, slot] of this.slots) if (slot.config.transport === 'auto') {
      this.dispose(slot); this.slots.delete(id);
    }
    this.reconcile(); this.revision++;
  }
  setTargets(scan: ScanResponse | null): void {
    this.targets = new Map((scan?.sources ?? []).filter(source => !source.error && !source.stale)
      .map(source => [source.id, source.sessions.filter(row => !row.isSubagent && THREAD_UUID.test(row.id))
        .slice(0, MAX_TARGETS).map(row => ({ id: row.id, key: row.key, changedAt: nativeFileChangedAt(source, row) }))]));
    for (const slot of this.slots.values()) {
      const keys = new Set(this.targets.get(slot.config.sourceId)?.map(row => row.key));
      for (const key of slot.samples.keys()) if (!keys.has(key)) this.drop(slot, key);
      for (const key of slot.previous.keys()) if (!keys.has(key)) slot.previous.delete(key);
    }
    this.reconcile();
  }
  start(): void { if (!this.running) { this.running = true; this.reconcile(); } }
  stop(): void {
    this.running = false;
    for (const slot of this.slots.values()) this.dispose(slot);
    this.slots.clear(); this.revision++;
  }
  private reconcile(): void {
    if (!this.running) return;
    for (const [id, slot] of this.slots) if (!this.targets.has(id)) {
      this.dispose(slot); this.slots.delete(id); this.revision++;
    }
    for (const config of this.configs) {
      if (!config.enabled || this.slots.has(config.sourceId) || !this.targets.has(config.sourceId)) continue;
      const slot: Slot = {
        config, generation: ++this.serial, client: null, timer: null, deadline: null,
        polling: false, failures: 0, cursor: 0, listAt: 0, loaded: new Map(), samples: new Map(), previous: new Map(),
        health: { sourceId: config.sourceId, transport: config.transport, state: 'connecting', reason: 'connecting',
          loaded: 0, matched: 0, covered: 0, listComplete: false, lastSuccessAt: null, retries: 0, ignoredRequests: 0 },
      };
      this.slots.set(config.sourceId, slot); this.schedule(slot, 0);
    }
  }
  private current(slot: Slot, generation: number): boolean {
    return this.running && this.slots.get(slot.config.sourceId) === slot && slot.generation === generation;
  }
  private drop(slot: Slot, key: string): void {
    if (slot.samples.delete(key)) this.revision++;
    slot.previous.delete(key);
  }
  private dispose(slot: Slot): void {
    slot.generation = ++this.serial;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.deadline) clearTimeout(slot.deadline);
    slot.timer = slot.deadline = null;
    const client = slot.client;
    slot.client = null; slot.samples.clear(); slot.previous.clear();
    void client?.close().catch(() => {});
  }
  private schedule(slot: Slot, delay: number): void {
    if (!this.running || slot.timer || this.slots.get(slot.config.sourceId) !== slot) return;
    slot.timer = setTimeout(() => { slot.timer = null; void this.poll(slot); }, delay);
    slot.timer.unref?.();
  }
  private collect(now = Date.now()): Map<string, NativeSample> {
    const samples = new Map<string, NativeSample>();
    for (const slot of this.slots.values()) for (const [key, sample] of slot.samples) {
      if (!freshNative(sample, now) || !slot.client || slot.client.closed) this.drop(slot, key);
      else samples.set(key, sample);
    }
    return samples;
  }
  project(scan: ScanResponse | null, now = Date.now()): ScanResponse | null {
    const samples = this.collect(now);
    if (this.cachedBase !== scan || this.cachedRevision !== this.revision) {
      this.cached = projectNativeScan(scan, samples, now);
      this.cachedBase = scan; this.cachedRevision = this.revision;
    }
    return this.cached;
  }
  health(now = Date.now()): NativeHealth[] {
    this.collect(now);
    return this.configs.map((config): NativeHealth => {
      const slot = this.slots.get(config.sourceId);
      if (!config.enabled || !slot) return { sourceId: config.sourceId, transport: config.transport,
        state: config.enabled ? 'degraded' : 'disabled', reason: config.enabled ? 'source-unavailable' : 'disabled',
        loaded: 0, matched: 0, covered: 0, listComplete: false, lastSuccessAt: null, retries: 0, ignoredRequests: 0 };
      const targets = this.targets.get(config.sourceId) ?? [];
      const covered = targets.filter(target => {
        const sample = slot.samples.get(target.key);
        return sample && !sample.isSubagent && sample.state !== 'unknown' && sample.state !== 'notLoaded' &&
          (target.changedAt == null || sample.at >= target.changedAt);
      }).length;
      return { ...slot.health, covered, ignoredRequests: slot.client?.stats.serverRequests ?? slot.health.ignoredRequests,
        ...(slot.health.state === 'connected' && slot.client?.closed
          ? { state: 'degraded' as const, reason: 'connection-unavailable' as const } : {}) };
    });
  }
  private async list(slot: Slot, client: NativeClient, generation: number): Promise<void> {
    const ids = new Map<string, string>(), cursors = new Set<string>();
    let cursor: string | null = null, complete = false;
    for (let page = 0; page < 50 && this.current(slot, generation); page++) {
      const raw = await client.request('thread/loaded/list', { limit: 100, cursor });
      const data = raw as { data?: unknown; nextCursor?: unknown } | null;
      if (!data || !Array.isArray(data.data) || data.data.length > 100) throw new Error('protocol');
      for (const id of data.data) if (typeof id === 'string' && THREAD_UUID.test(id)) ids.set(id.toLowerCase(), id);
      const next: string | null = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      if (!next) { complete = true; break; }
      if (next.length > 4096 || cursors.has(next) || !data.data.length) break;
      cursors.add(next); cursor = next;
    }
    if (!this.current(slot, generation)) return;
    slot.loaded = ids; slot.listAt = Date.now();
    slot.health.loaded = ids.size; slot.health.listComplete = complete;
    // Absence in a partial list is unknown, not proof of idle/completed.
    if (complete) for (const [key] of slot.samples) {
      const target = this.targets.get(slot.config.sourceId)?.find(row => row.key === key);
      if (!target || !ids.has(target.id.toLowerCase())) this.drop(slot, key);
    }
  }
  private async poll(slot: Slot): Promise<void> {
    if (slot.polling || !this.running) return;
    slot.polling = true;
    const generation = slot.generation, previousVersion = this.revision;
    const previousHealth = JSON.stringify([slot.health.state, slot.health.reason, slot.health.matched]);
    const waiting: string[] = [];
    let timedOut = false;
    slot.deadline = setTimeout(() => { timedOut = true; void slot.client?.close().catch(() => {}); }, CYCLE_MS);
    slot.deadline.unref?.();
    try {
      this.collect();
      if (!slot.client || slot.client.closed) {
        slot.previous.clear();
        const config = slot.config;
        if (config.transport === 'auto' && (/^[\\/]{2}/.test(this.home) || this.home.startsWith('\\')))
          throw new Error('network-home');
        const endpoint = parseProbeEndpoint({ home: this.home,
          ...(config.transport === 'socket' ? { socket: config.endpoint } : {}),
          ...(config.transport === 'ws' ? { ws: config.endpoint } : {}) });
        slot.client = this.factory(endpoint);
        await slot.client.start(); slot.listAt = 0;
      }
      const client = slot.client;
      if (!this.current(slot, generation)) return;
      if (timedOut) throw new Error('cycle-timeout');
      if (!slot.listAt || Date.now() - slot.listAt >= LIST_MS) await this.list(slot, client, generation);
      if (!this.current(slot, generation)) return;
      if (timedOut) throw new Error('cycle-timeout');
      const targets = (this.targets.get(slot.config.sourceId) ?? []).filter(row => slot.loaded.has(row.id.toLowerCase()));
      slot.health.matched = targets.length;
      const selected: Target[] = [];
      for (let i = 0; i < Math.min(MAX_READS, targets.length); i++) selected.push(targets[(slot.cursor + i) % targets.length]!);
      slot.cursor = targets.length ? (slot.cursor + selected.length) % targets.length : 0;
      let next = 0, failed = 0, unsupported = 0, unavailable = 0;
      await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
        while (next < selected.length && this.current(slot, generation) && !timedOut) {
          const target = selected[next++]!, id = slot.loaded.get(target.id.toLowerCase())!, at = Date.now();
          try {
            const raw = await client.request('thread/read', { threadId: id, includeTurns: false });
            if (!this.current(slot, generation) || timedOut) return;
            const latest = this.targets.get(slot.config.sourceId)?.find(row => row.key === target.key);
            if (!latest) { this.drop(slot, target.key); continue; }
            const row = parseNativeThread((raw as { thread?: unknown } | null)?.thread, id);
            if (!row) { unsupported++; this.drop(slot, target.key); continue; }
            if (row.state === 'notLoaded' || row.isSubagent) { unavailable++; this.drop(slot, target.key); continue; }
            const old = slot.samples.get(target.key), prior = slot.previous.get(target.key);
            // An observation older than a concurrent file write cannot advance
            // the alert baseline either: the next valid read must still be
            // able to report this newly pending state.
            if (latest.changedAt == null || latest.changedAt <= at) {
              if (prior && isNativeWaiting(row) && !isNativeWaiting(prior)) waiting.push(target.key);
              slot.previous.set(target.key, { state: row.state, flags: row.flags });
            }
            if (signature(old) !== signature(row) || (old && latest.changedAt != null &&
                old.at < latest.changedAt && at >= latest.changedAt)) this.revision++;
            slot.samples.set(target.key, { ...row, key: target.key, sourceId: slot.config.sourceId, at });
          } catch {
            failed++; this.drop(slot, target.key);
          }
        }
      }));
      if (!this.current(slot, generation)) return;
      if (timedOut || client.closed) throw new Error('connection');
      slot.failures = 0;
      slot.health.state = failed || unsupported ? 'degraded' : 'connected';
      slot.health.reason = failed ? 'request-failed' : unsupported ? 'protocol-unsupported' :
        !targets.length ? 'no-matching-threads' : unavailable || !slot.health.listComplete || targets.length > MAX_READS
          ? 'partial-coverage' : 'metadata-only';
      slot.health.lastSuccessAt = Date.now();
    } catch {
      if (!this.current(slot, generation)) return;
      slot.health.state = 'degraded'; slot.health.reason = 'connection-unavailable';
      slot.health.retries++; slot.failures++;
      slot.health.ignoredRequests = slot.client?.stats.serverRequests ?? slot.health.ignoredRequests;
      const client = slot.client; slot.client = null;
      await client?.close().catch(() => {});
      slot.samples.clear(); slot.previous.clear(); waiting.length = 0; this.revision++;
    } finally {
      if (slot.deadline) clearTimeout(slot.deadline);
      slot.deadline = null; slot.polling = false;
      if (this.current(slot, generation)) {
        if (previousVersion !== this.revision || waiting.length ||
            previousHealth !== JSON.stringify([slot.health.state, slot.health.reason, slot.health.matched])) this.changed(waiting);
        this.schedule(slot, slot.failures ? Math.min(60_000, 4000 * 2 ** Math.min(4, slot.failures - 1)) : POLL_MS);
      }
    }
  }
}
