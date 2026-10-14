import type { SignalAppearance } from './types';

/** Native Window Controls Overlay should blend into the renderer chrome. */
export function titlebarPalette(appearance: SignalAppearance): { color: string; symbolColor: string; height: number } {
  switch (appearance) {
    case 'ember': return { color: '#181411', symbolColor: '#e6d6cd', height: 40 };
    case 'mist': return { color: '#f7fbfa', symbolColor: '#26484e', height: 40 };
    default: return { color: '#0b151f', symbolColor: '#e1eded', height: 40 };
  }
}
