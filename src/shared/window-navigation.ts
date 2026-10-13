import type { OriginalWindowFocusResult } from './types';

/** A partial jump has already activated the original top-level window.
 * Do not bring Monitor back to the foreground just because tab selection
 * was unavailable; notification read state is handled independently.
 */
export function windowWasActivated(result: OriginalWindowFocusResult): boolean {
  return result.state === 'focused' || result.state === 'opened' || result.state === 'partial';
}
