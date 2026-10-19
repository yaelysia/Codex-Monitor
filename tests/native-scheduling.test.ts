import { describe, expect, it } from 'vitest';
import { chooseNativeReads, nativeListInterval, nativeReadDueIn, nextNativeReadDueIn,
  NATIVE_ACTIVE_READ_MS, NATIVE_QUIET_READ_MS } from '../src/shared/native-scheduling';
import type { NativeReadObservation, NativeReadTarget } from '../src/shared/native-scheduling';
const now = 1_800_000_000_000;
const candidate = (key: string, changedAt: number | null = null): NativeReadTarget => ({ key, changedAt });
const history = (keys: readonly string[], at: number, state: NativeReadObservation['state']) =>
  new Map(keys.map(key => [key, { at, state }]));
describe('bounded adaptive native read scheduling', () => {
  it('polls active/waiting at 3 s, quiet at 12 s, without relaxing native evidence TTL', () => {
    const active = history(['active'], now, 'active'), idle = history(['idle'], now, 'idle');
    expect(nativeReadDueIn(candidate('active'), active.get('active'), now + 2999)).toBe(1);
    expect(nativeReadDueIn(candidate('active'), active.get('active'), now + 3000)).toBe(0);
    expect(nativeReadDueIn(candidate('idle'), idle.get('idle'), now + 3000)).toBe(9000);
    expect(nativeReadDueIn(candidate('idle'), idle.get('idle'), now + 12000)).toBe(0);
    expect(NATIVE_ACTIVE_READ_MS).toBeLessThan(NATIVE_QUIET_READ_MS);
  });
  it('makes unread targets and newer file writes immediately due; never extends backwards clocks', () => {
    const seen = history(['known'], now, 'idle');
    expect(nativeReadDueIn(candidate('new'), seen.get('new'), now + 500)).toBe(0);
    expect(nativeReadDueIn(candidate('known', now + 1), seen.get('known'), now + 500)).toBe(0);
    expect(nativeReadDueIn(candidate('known'), seen.get('known'), now - 1)).toBe(0);
    expect(nativeReadDueIn(candidate('known'), seen.get('known'), now + 2, true)).toBe(0);
  });
  it('reads no unchanged quiet threads at 3, 6 or 9 seconds; refreshes all at 12', () => {
    const rows = Array.from({ length: 60 }, (_, n) => candidate(String(n)));
    const attempts = history(rows.map(row => row.key), now, 'idle');
    const urgent = new Set<string>();
    for (const elapsed of [3000, 6000, 9000])
      expect(chooseNativeReads(rows, attempts, urgent, now + elapsed)).toHaveLength(0);
    expect(chooseNativeReads(rows, attempts, urgent, now + 12000)).toHaveLength(60);
  });
  it('prioritizes urgent pushes and unseen threads without starving over-capacity sessions', () => {
    const rows = Array.from({ length: 150 }, (_, n) => candidate(String(n)));
    const attempts = new Map<string, NativeReadObservation>();
    const seen = new Set<string>(), urgent = new Set<string>();
    for (let pass = 0; pass < 3; pass++) {
      const picked = chooseNativeReads(rows, attempts, urgent, now + pass * 3000);
      expect(picked.length).toBe(pass === 2 ? 22 : 64);
      for (const row of picked) {
        expect(seen.has(row.key)).toBe(false);
        seen.add(row.key); attempts.set(row.key, { state: 'active', at: now + pass * 3000 });
      }
    }
    expect(seen.size).toBe(150);
    urgent.add(rows[149]!.key);
    expect(chooseNativeReads(rows, attempts, urgent, now + 6010)[0]?.key).toBe(rows[149]!.key);
  });
  it('prioritizes a long overdue sample above a barely due active sample', () => {
    const rows = [candidate('fresh'), candidate('stale')];
    const attempts = new Map<string, NativeReadObservation>([
      ['fresh', { at: now - 3000, state: 'active' }],
      ['stale', { at: now - 18000, state: 'idle' }],
    ]);
    expect(chooseNativeReads(rows, attempts, new Set(), now).map(row => row.key))
      .toEqual(['stale', 'fresh']);
  });
  it('computes next deadline without a busy spin; list discovery slows only for quiet sources', () => {
    const rows = [candidate('x'), candidate('y')];
    const attempts = new Map<string, NativeReadObservation>([
      ['x', { at: now, state: 'idle' }], ['y', { at: now, state: 'active' }],
    ]);
    expect(nextNativeReadDueIn(rows, attempts, new Set(), now)).toBe(3000);
    expect(nativeListInterval(attempts, now)).toBe(10000);
    attempts.set('y', { at: now - 16000, state: 'active' });
    expect(nativeListInterval(attempts, now)).toBe(30000);
  });
});
