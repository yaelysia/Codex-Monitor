import type { ScanResponse } from './types';

export const MAX_PINNED_ROLLOUTS = 16;
const RELATIVE_ROLLOUT = /^\d{4}\/\d{2}\/\d{2}\/[^/\\\x00-\x1f]{1,220}\.jsonl$/i;

/** Accept Codex sessions/YYYY/MM/DD/*.jsonl locators only, never arbitrary
 * filesystem paths, shell commands or traversal from a renderer.
 */
export function validPinnedRolloutPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 280 &&
    RELATIVE_ROLLOUT.test(value) && !value.includes('..');
}

/** Prefer the oldest known active parent so it survives recent-200 eviction.
 * These are candidate file locators, NOT proof an old session stays alive.
 */
export function pinnedRolloutsBySource(scan: ScanResponse | null): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const source of scan?.sources ?? []) {
    if (source.error) continue;
    const pins = [...source.sessions].filter(row => !row.isSubagent &&
      row.status === 'working' && validPinnedRolloutPath(row.rolloutPath))
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, MAX_PINNED_ROLLOUTS);
    if (pins.length) result.set(source.id, [...new Set(pins.map(row => row.rolloutPath!))]);
  }
  return result;
}
