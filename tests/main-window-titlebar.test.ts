import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeDock } from '../src/shared/window-geometry';

const fake = vi.hoisted(() => ({ windows: [] as any[] }));
vi.mock('electron', () => {
  class FakeBrowserWindow {
    options: any;
    titlebar: any = null;
    background = '';
    readonly webContents = {
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      isLoadingMainFrame: () => false,
      send: () => undefined,
    };
    constructor(options: any) {
      this.options = options;
      fake.windows.push(this);
    }
    isMinimized() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    isDestroyed() { return false; }
    show() {}
    focus() {}
    on() {}
    setTitleBarOverlay(value: any) { this.titlebar = value; }
    setBackgroundColor(value: string) { this.background = value; }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
  }
  const display = { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  return {
    BrowserWindow: FakeBrowserWindow,
    screen: { getPrimaryDisplay: () => display, getAllDisplays: () => [display] },
  };
});

import { MainWindowController } from '../electron/main-window';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  fake.windows.length = 0;
});

describe('native Windows titlebar integration', () => {
  it('uses native close/minimize/maximize over the same renderer header and follows the theme', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const store = {
      snapshot: () => ({ dock: normalizeDock({ appearance: 'mist' }), mainBounds: null }),
      updateMainBounds: () => undefined,
    } as any;
    const controller = new MainWindowController(() => undefined, store);
    controller.show();
    const win = fake.windows[0]!;
    expect(win.options.titleBarStyle).toBe('hidden');
    expect(win.options.titleBarOverlay).toEqual({
      color: '#f7fbfa', symbolColor: '#26484e', height: 60,
    });
    controller.setTitlebarAppearance('ember');
    expect(win.titlebar).toEqual({ color: '#181411', symbolColor: '#e6d6cd', height: 60 });
    expect(win.background).toBe('#181411');
  });

  it('leaves the native titlebar unchanged outside Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const store = {
      snapshot: () => ({ dock: normalizeDock({}), mainBounds: null }),
      updateMainBounds: () => undefined,
    } as any;
    const controller = new MainWindowController(() => undefined, store);
    controller.show();
    expect(fake.windows[0]!.options.titleBarOverlay).toBeUndefined();
    expect(fake.windows[0]!.options.titleBarStyle).toBeUndefined();
    controller.setTitlebarAppearance('ember');
    expect(fake.windows[0]!.titlebar).toBeNull();
  });
});
