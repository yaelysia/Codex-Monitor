import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import DiagnosticsApp from '../src/renderer/DiagnosticsApp';
const read = (path: string) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

describe('diagnostic center entry points and read-only presentation', () => {
  it('renders the health center without requiring a running native server', () => {
    const html = renderToStaticMarkup(createElement(DiagnosticsApp));
    for (const text of ['诊断中心', '健康总览', '状态轨迹', '原生状态接入', '导出脱敏报告', '尚未启用原生接入'])
      expect(html).toContain(text);
  });
  it('uses existing controls and a visibility-gated refresh without starting collectors', () => {
    const app = read('src/renderer/DiagnosticsApp.tsx');
    expect(app).toContain('SignalSelect'); expect(app).toContain('useVisibleInterval');
    expect(app).not.toContain('monitorApi.refresh(');
    expect(read('electron/tray.ts')).toContain('诊断中心 / 原生状态');
    expect(read('electron.vite.config.ts')).toContain('diagnostics.html');
  });
  it('isolates the on-demand window and restricts navigation', () => {
    const window = read('electron/diagnostics-window.ts');
    expect(window).toContain('contextIsolation: true'); expect(window).toContain('nodeIntegration: false');
    expect(window).toContain('sandbox: true'); expect(window).toContain("action: 'deny'");
    expect(read('electron/main.ts')).toContain('diagnostics?.destroy()');
    expect(read('electron/diagnostics-ipc.ts')).toContain('event.senderFrame !== win.webContents.mainFrame');
  });
});
