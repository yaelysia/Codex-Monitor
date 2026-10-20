import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeConnection, NativeSample, NativeStatus } from '../src/shared/native-state';
import type { ScanResponse, MonitorAlert } from '../src/shared/types';
const fake = vi.hoisted(() => ({
  change: null as null | ((keys: readonly string[]) => void), revision: 0,
  samples: new Map<string, NativeSample>(), configure: vi.fn(), save: vi.fn(),
}));
vi.mock('../electron/native-monitor', async () => {
  const { projectNativeScan } = await import('../src/shared/native-state');
  return { NativeMonitor: class {
    constructor(_home: string, callback: (keys: readonly string[]) => void) { fake.change = callback; }
    get revision() { return fake.revision; }
    configure(rows: NativeConnection[]) { fake.configure(rows); fake.samples.clear(); fake.revision++; }
    setTargets() {} setHome() {} start() {} stop() { fake.samples.clear(); fake.revision++; }
    health() { return []; }
    coverage() { return []; }
    project(scan: ScanResponse | null) { return projectNativeScan(scan, fake.samples); }
  } };
});
vi.mock('../electron/native-settings', async () => {
  const actual = await vi.importActual<typeof import('../electron/native-settings')>('../electron/native-settings');
  return { ...actual, NativeSettingsStore: class { load() { return []; } save = fake.save; } };
});
vi.mock('../electron/config', () => ({ readSettings: vi.fn(async () => ({ localRoot: '', wslRoots: {}, remotes: [] })) }));
vi.mock('../electron/collector', () => ({
  refresh: vi.fn(), projectDesktopRuntime: vi.fn(async (scan: ScanResponse) => scan), recentDesktopCompletions: vi.fn(() => []),
}));
vi.mock('../electron/watchers', () => ({ WatchCoordinator: class { status() { return {}; } start() {} stop() {} reconcile() {} } }));
vi.mock('../electron/desktop-log-watch', () => ({ DesktopLogFolderWatcher: class { close() {} } }));
import { MonitorService } from '../electron/monitor-service';
import { refresh } from '../electron/collector';
const NOW = 1_800_000_000_000, id = '019a1020-0000-7000-8000-777788889999', key = 'local:' + id;
function scan(): ScanResponse {
  return { scannedAt: NOW, sources: [{ id: 'local', label: 'Local', kind: 'local', error: null, capturedAt: NOW,
    sessions: [{ id, key, sourceId: 'local', sourceLabel: 'Local', title: 'Task', workspace: null,
      status: 'unknown', statusReason: 'log', updatedAt: NOW - 1000, ageAtSourceMs: 1000, startedAt: null }] }] };
}
let service: MonitorService | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); fake.samples.clear(); fake.revision = 0;
  fake.configure.mockReset(); fake.save.mockReset(); fake.change = null;
  vi.mocked(refresh).mockReset(); vi.mocked(refresh).mockResolvedValue(scan());
});
afterEach(() => { service?.stop(); service = undefined; vi.useRealTimers(); });
function emit(state: NativeStatus, waiting = false) {
  fake.samples.set(key, { ...state, key, sourceId: 'local', at: Date.now(), isSubagent: false });
  fake.revision++; fake.change?.(waiting ? [key] : []);
}
async function setup() {
  const alerts: MonitorAlert[] = [], changed = vi.fn();
  service = new MonitorService(changed, row => alerts.push(row), undefined, 'linux');
  service.start(); await vi.advanceTimersByTimeAsync(0);
  return { service, alerts, changed };
}
describe('native state integration with authoritative MonitorService', () => {
  it('updates displayed state and waiting inbox without rescanning or mutating raw log evidence', async () => {
    const run = await setup();
    emit({ state: 'active', flags: [] }); expect(run.service.state().scan?.sources[0]!.sessions[0]!.status).toBe('working');
    await vi.advanceTimersByTimeAsync(1);
    emit({ state: 'active', flags: ['waitingOnUserInput'] }, true);
    expect(run.alerts).toHaveLength(1); expect(run.alerts[0]!.kind).toBe('waiting');
    expect(refresh).toHaveBeenCalledTimes(1);
    fake.samples.clear(); fake.revision++; fake.change?.([]);
    const fallback = run.service.state();
    expect(fallback.scan?.sources[0]!.sessions[0]!.status).toBe('unknown');
    expect(fallback.scan?.sources[0]!.sessions[0]!.nativeStatus).toBeUndefined();
    expect(run.service.acknowledgeForegroundSessions(candidate => candidate === key)).toBe(1);
    expect(run.service.state().alerts[0]!.read).toBe(true);
  });
  it('honors mute/type settings and does not turn idle/systemError into completion alerts', async () => {
    const run = await setup(); run.service.setMuted(true);
    emit({ state: 'active', flags: ['waitingOnApproval'] }, true);
    expect(run.alerts).toEqual([]); expect(run.service.state().alerts[0]!.read).toBe(false);
    run.service.setNotificationKindEnabled('waiting', false);
    emit({ state: 'active', flags: [] }); await vi.advanceTimersByTimeAsync(1);
    emit({ state: 'active', flags: ['waitingOnUserInput'] }, true);
    expect(run.service.state().alerts.every(row => row.read)).toBe(true);
    emit({ state: 'idle', flags: [] }); emit({ state: 'systemError', flags: [] });
    expect(run.service.state().alerts.every(row => row.kind === 'waiting')).toBe(true);
  });
  it('preserves connections after failed save and keeps unknown sources disabled', async () => {
    const run = await setup();
    const rows: NativeConnection[] = [{ sourceId: 'local', enabled: true, transport: 'auto', endpoint: '' }];
    expect(() => run.service.setNativeConnections([{ ...rows[0], sourceId: 'ssh:missing' }])).toThrow();
    fake.save.mockImplementationOnce(() => { throw new Error('save failed'); });
    expect(() => run.service.setNativeConnections(rows)).toThrow('save failed');
    expect(run.service.nativeConnections()).toEqual([]); expect(fake.configure).not.toHaveBeenCalled();
    run.service.setNativeConnections(rows); expect(run.service.nativeConnections()).toEqual(rows);
    expect(fake.configure).toHaveBeenCalledOnce();
    run.service.setNativeConnections(rows); expect(fake.configure).toHaveBeenCalledOnce();
  });
  it('clears diagnostic traces without acknowledging alerts or altering configuration', async () => {
    const run = await setup(); emit({ state: 'active', flags: ['waitingOnApproval'] }, true);
    const before = run.service.state().alerts;
    expect(run.service.diagnostics().report.events.length).toBeGreaterThan(0);
    expect(run.service.clearDiagnostics().report.events).toEqual([]);
    expect(run.service.state().alerts).toEqual(before); expect(fake.save).not.toHaveBeenCalled();
  });
});
