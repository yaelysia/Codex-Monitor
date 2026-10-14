import type { OriginalWindowFocusResult } from './types';

/** A partial HWND jump has already activated the original top-level
 * window. An opened result means the official Desktop protocol was handed to
 * Windows; displaying Monitor on top would cover that transition.
 */
export function windowWasActivated(result: OriginalWindowFocusResult): boolean {
  return result.state === 'focused' || result.state === 'opened' || result.state === 'partial';
}
