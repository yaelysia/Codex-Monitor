import { describe, expect, it } from 'vitest';
import { windowWasActivated } from '../src/shared/window-navigation';
import type { OriginalWindowFocusResult } from '../src/shared/types';

describe('original window focus results', () => {
  it.each(['focused', 'partial'] as const)(
    'leaves the original window in the foreground after %s', state => {
      const result: OriginalWindowFocusResult = { state, message: 'observed' };
      expect(windowWasActivated(result)).toBe(true);
    },
  );
  it.each(['unbound', 'unavailable', 'stale', 'blocked'] as const)(
    'falls back to Monitor only after %s', state => {
      const result: OriginalWindowFocusResult = { state, message: 'not activated' };
      expect(windowWasActivated(result)).toBe(false);
    },
  );
});
