import { NATIVE_SAMPLE_TTL_MS, type NativeState } from './native-state';

export const NATIVE_ACTIVE_READ_MS = 3_000;
export const NATIVE_QUIET_READ_MS = 12_000;
export const NATIVE_ACTIVE_LIST_MS = 10_000;
export const NATIVE_QUIET_LIST_MS = 30_000;
export const NATIVE_PUSH_WAKE_MS = 150;
export const MAX_NATIVE_READS = 64;

export interface NativeReadTarget { key: string; changedAt: number | null }
export interface NativeReadObservation { at: number; state: NativeState }

/** A live or waiting turn gets the original 3 s audit. An idle, errored or
 * unrecognized thread is checked at least every 12 s while it is loaded.
 * The 15 s evidence TTL still applies: no extrapolating a cached status.
 */
export function nativeReadInterval(state: NativeState): number {
  return state === 'active' ? NATIVE_ACTIVE_READ_MS : NATIVE_QUIET_READ_MS;
}

export function nativeReadDueIn(target: NativeReadTarget,
  previous: NativeReadObservation | undefined, now: number, urgent = false): number {
  if (urgent || !previous || (target.changedAt != null && target.changedAt > previous.at) ||
      now < previous.at) return 0;
  return Math.max(0, nativeReadInterval(previous.state) - (now - previous.at));
}

/** Work conservation and fairness: urgent events/file changes, unseen threads,
 * and overdue samples win. A bounded queue rotates rather than repeatedly
 * selecting the first 64 active threads and starving the remainder.
 */
export function chooseNativeReads<T extends NativeReadTarget>(
  targets: readonly T[], attempts: ReadonlyMap<string, NativeReadObservation>,
  urgent: ReadonlySet<string>, now: number, limit = MAX_NATIVE_READS,
): T[] {
  const eligible = targets.filter(target =>
    nativeReadDueIn(target, attempts.get(target.key), now, urgent.has(target.key)) === 0);
  eligible.sort((a, b) => {
    const score = (target: T): [number, number, number] => {
      const previous = attempts.get(target.key);
      if (urgent.has(target.key) || (previous && target.changedAt != null &&
          target.changedAt > previous.at)) return [4, 0, previous?.at ?? -1];
      if (!previous || now < previous.at) return [3, 0, -1];
      const age = now - previous.at, interval = nativeReadInterval(previous.state);
      return [age > NATIVE_SAMPLE_TTL_MS ? 2 : 1, age / interval, -previous.at];
    };
    const sa = score(a), sb = score(b);
    return sb[0] - sa[0] || sb[1] - sa[1] || sb[2] - sa[2] ||
      a.key.localeCompare(b.key);
  });
  return eligible.slice(0, Math.max(0, Math.min(MAX_NATIVE_READS, limit)));
}

export function nextNativeReadDueIn(
  targets: readonly NativeReadTarget[], attempts: ReadonlyMap<string, NativeReadObservation>,
  urgent: ReadonlySet<string>, now: number,
): number {
  let next = Infinity;
  for (const target of targets) {
    const delay = nativeReadDueIn(target, attempts.get(target.key), now, urgent.has(target.key));
    if (delay < next) next = delay;
  }
  return next;
}

/** The loaded-list discovery remains periodic even when all threads are quiet. */
export function nativeListInterval(
  attempts: ReadonlyMap<string, NativeReadObservation>, now: number,
): number {
  for (const previous of attempts.values()) {
    if (previous.state === 'active' && now >= previous.at &&
        now - previous.at <= NATIVE_SAMPLE_TTL_MS) return NATIVE_ACTIVE_LIST_MS;
  }
  return NATIVE_QUIET_LIST_MS;
}
