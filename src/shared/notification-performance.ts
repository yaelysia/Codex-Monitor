import type { MonitorAlert, NotificationLagMetrics, ScanResponse } from './types';
import { sessionObservedAt } from './session-time';

const MAX_SAMPLES = 128;
const MAX_VALID_LAG_MS = 10 * 60_000;

/** On-source timestamp difference removes cross-host wall-clock skew. It is an
 * estimate of event persistence to Monitor discovery, NOT OS-toast latency.
 * GUI native events and questions without parseable times are excluded.
 */
export function estimateNotificationLag(
  alert: MonitorAlert, scan: ScanResponse, now: number,
): number | null {
  const source = scan.sources.find(item => !item.error &&
    item.sessions.some(session => session.key === alert.sessionKey));
  const session = source?.sessions.find(row => row.key === alert.sessionKey);
  if (!source || !session || typeof source.capturedAt !== 'number' ||
      !Number.isFinite(source.capturedAt) ||
      typeof session.ageAtSourceMs !== 'number' ||
      !Number.isFinite(session.ageAtSourceMs)) return null;
  let token: unknown;
  try {
    const parts: unknown = JSON.parse(alert.id);
    if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== alert.sessionKey ||
        parts[1] !== alert.kind) return null;
    token = parts[2];
  } catch { return null; }
  if (typeof token !== 'string' || token.indexOf('|') < 10) return null;
  const eventAt = Date.parse(token.slice(0, token.indexOf('|')));
  if (!Number.isFinite(eventAt)) return null;
  const observedFileAt = sessionObservedAt(session, source);
  const estimatedAt = observedFileAt - (session.updatedAt - eventAt);
  const age = now - estimatedAt;
  if (!Number.isFinite(age) || age < 0 || age > MAX_VALID_LAG_MS) return null;
  return Math.round(age);
}

export class NotificationPerformance {
  private samples: number[] = [];

  observe(alerts: readonly MonitorAlert[], scan: ScanResponse, now: number): void {
    for (const alert of alerts) {
      const lag = estimateNotificationLag(alert, scan, now);
      if (lag == null) continue;
      this.samples.push(lag);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    }
  }

  snapshot(): NotificationLagMetrics | null {
    if (!this.samples.length) return null;
    const sorted = [...this.samples].sort((a,b) => a-b);
    const percentile = (p: number) =>
      sorted[Math.ceil(p * sorted.length) - 1]!;
    return { samples: sorted.length,
      p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1)! };
  }
}
