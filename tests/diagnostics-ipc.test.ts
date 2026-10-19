import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorService } from '../electron/monitor-service';
import type { DiagnosticsWindowController } from '../electron/diagnostics-window';
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw?: unknown) => unknown>(),
  save: vi.fn(), write: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, raw?: unknown) => unknown) => fake.handlers.set(channel, handler) },
  dialog: { showSaveDialog: fake.save },
}));
vi.mock('node:fs/promises', () => ({ default: { writeFile: fake.write } }));
import { registerDiagnosticsIpc } from '../electron/diagnostics-ipc';
function setup() {
  const frame = {}, sender = { mainFrame: frame }, event = { sender, senderFrame: frame };
  const win = { webContents: sender };
  const report = { version: 1, events: [{ source: 'S1', session: 'T1', kind: 'session', status: 'working' }] };
  const monitor = { diagnostics: vi.fn(() => ({ report, sessions: [{ key: 'SECRET_ID', title: 'SECRET_TITLE' }] })),
    clearDiagnostics: vi.fn(), nativeConnections: vi.fn(() => []), setNativeConnections: vi.fn() };
  registerDiagnosticsIpc(monitor as unknown as MonitorService,
    { window: () => win } as unknown as DiagnosticsWindowController);
  const call = (channel: string, raw?: unknown, from: unknown = event) => fake.handlers.get(channel)!(from, raw);
  return { report, monitor, call, event, sender };
}
beforeEach(() => { fake.handlers.clear(); fake.save.mockReset(); fake.write.mockReset(); fake.write.mockResolvedValue(undefined); });

describe('diagnostic center IPC and user-directed export', () => {
  it('rejects other windows and subframes for every new endpoint', async () => {
    const run = setup();
    for (const channel of fake.handlers.keys()) {
      const bad = { sender: {}, senderFrame: run.event.senderFrame };
      const child = { sender: run.sender, senderFrame: {} };
      if (channel === 'diagnostics:export') {
        await expect(run.call(channel, undefined, bad)).rejects.toThrow('诊断接口');
        await expect(run.call(channel, undefined, child)).rejects.toThrow('诊断接口');
      } else {
        expect(() => run.call(channel, undefined, bad)).toThrow('诊断接口');
        expect(() => run.call(channel, undefined, child)).toThrow('诊断接口');
      }
    }
    expect(fake.save).not.toHaveBeenCalled(); expect(fake.write).not.toHaveBeenCalled();
  });
  it('exports the authoritative redacted report only to the native dialog-selected path', async () => {
    const run = setup(); fake.save.mockResolvedValue({ canceled: false, filePath: '/selected/report.json' });
    expect(await run.call('diagnostics:export', { path: '/attacker/file', report: 'SECRET' })).toBe('saved');
    expect(fake.write).toHaveBeenCalledWith('/selected/report.json', JSON.stringify(run.report, null, 2), { mode: 0o600 });
    expect(fake.write.mock.calls[0]![1]).not.toContain('SECRET');
  });
  it('does not write when the user cancels and hides raw filesystem errors', async () => {
    const run = setup(); fake.save.mockResolvedValue({ canceled: true });
    expect(await run.call('diagnostics:export')).toBe('cancelled'); expect(fake.write).not.toHaveBeenCalled();
    fake.save.mockResolvedValue({ canceled: false, filePath: '/private/report' });
    fake.write.mockRejectedValue(new Error('SECRET_PATH_PERMISSION'));
    await expect(run.call('diagnostics:export')).rejects.toThrow('诊断报告导出失败');
  });
  it('allows only one outstanding save dialog and releases the guard afterwards', async () => {
    const run = setup(); let resolve: (value: unknown) => void = () => {};
    fake.save.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
    const first = run.call('diagnostics:export');
    expect(await run.call('diagnostics:export')).toBe('cancelled');
    resolve({ canceled: true }); expect(await first).toBe('cancelled');
    fake.save.mockResolvedValue({ canceled: true }); await run.call('diagnostics:export');
    expect(fake.save).toHaveBeenCalledTimes(2);
  });
  it('routes clears and settings through their separate validated service boundaries', () => {
    const run = setup(), config: unknown[] = [];
    run.call('diagnostics:clear'); expect(run.monitor.clearDiagnostics).toHaveBeenCalledOnce();
    run.call('diagnostics:native-set', config); expect(run.monitor.setNativeConnections).toHaveBeenCalledWith(config);
    expect(run.call('diagnostics:native-get')).toEqual([]);
  });
});
