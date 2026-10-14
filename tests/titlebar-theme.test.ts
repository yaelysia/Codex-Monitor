import { describe, expect, it } from 'vitest';
import { titlebarPalette } from '../src/shared/titlebar-theme';

describe('Signal Studio native Windows caption palette', () => {
  it('matches every available visual theme with a fully opaque caption color', () => {
    const expected = {
      moonsea: ['#0b151f', '#e1eded'],
      ember: ['#181411', '#e6d6cd'],
      mist: ['#f7fbfa', '#26484e'],
    } as const;
    for (const [appearance, [color, symbolColor]] of Object.entries(expected)) {
      const overlay = titlebarPalette(appearance as keyof typeof expected);
      expect(overlay).toEqual({ color, symbolColor, height: 40 });
      expect(overlay.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
