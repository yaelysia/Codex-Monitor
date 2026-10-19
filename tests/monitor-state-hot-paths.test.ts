import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertTrackerPersistence, SavedAlert } from '../src/shared/alert-tracker';

const store = vi.hoisted(() => ({ saved: null as AlertTrackerPersistence | null, update: vi.fn() }));
vi.mock('../electron/alert-store', () => ({ AlertStateStore: class {
  load() { return store.saved; }
  update(snapshot: AlertTrackerPersistence) { store.update(snapshot); }
  flush() {}
} }));
vi.mock('../electron/config', () => ({ readSettings: vi.fn() }));
vi.mock('../electron/collector', () => ({
  refresh: vi.fn(), projectDesktopRuntime: vi.fn(), recentDesktopCompletions: vi.fn(() => []),
}));
vi.mock('../electron/watchers', () => ({ WatchCoordinator: class {
  status() { return {}; }
  stop() {}
} }));
vi.mock('../electron/desktop-log-watch', () => ({ DesktopLogFolderWatcher: class { close() {} } }));
import { MonitorService } from '../electron/monitor-service';

function alert(id: string, sessionKey: string, kind: SavedAlert['kind'] = 'finished'): SavedAlert {
  return { id, sessionKey, sessionId: sessionKey, kind, at: 1_800_000_000_000, read: false };
}
beforeEach(() => {
  store.saved = { version: 1, muted: false, seenAlertIds: [], alerts: [
    alert('a1', 'local:a'), alert('a2', 'local:a', 'waiting'), alert('b1', 'local:b'),
    alert('c1', 'local:c'), alert('source', 'local:a', 'source-offline'),
  ] };
  store.update.mockClear();
});
afterEach(() => vi.restoreAllMocks());

function setup() {
  const change = vi.fn();
  // Do not start collectors or native listeners; exercise the state boundary.
  const service = new MonitorService(change, vi.fn(), undefined, 'linux', 'mock-store');
  return { service, change, state: vi.spyOn(service, 'state') };
}

describe('one publication per logical inbox change', () => {
  it('batches confirmed sessions, checks each once, and leaves other/source alerts unread', () => {
    const { service, change, state } = setup();
    const foreground = vi.fn((key: string) => key === 'local:a' || key === 'local:b');
    expect(service.acknowledgeForegroundSessions(foreground)).toBe(3);
    expect(foreground.mock.calls.map(([key]) => key)).toEqual(['local:a', 'local:b', 'local:c']);
    expect(change).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0]![0].alerts.filter((item: SavedAlert) => !item.read)
      .map((item: SavedAlert) => item.id)).toEqual(['c1', 'source']);
    expect(service.acknowledgeForegroundSessions(foreground)).toBe(0);
    expect(change).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledTimes(1);
  });

  it('does no foreground work for an empty inbox, and does not guess an ambiguous session', () => {
    const { service, change, state } = setup();
    expect(service.acknowledgeForegroundSessions(() => false)).toBe(0);
    expect(change).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    store.saved!.alerts = [];
    const empty = setup();
    const foreground = vi.fn(() => true);
    expect(empty.service.acknowledgeForegroundSessions(foreground)).toBe(0);
    expect(foreground).not.toHaveBeenCalled();
    expect(empty.change).not.toHaveBeenCalled();
  });

  it('keeps explicit single-session navigation scoped and idempotent', () => {
    const { service, change } = setup();
    expect(service.acknowledgeSessionAlerts('local:a')).toBe(2);
    expect(service.acknowledgeSessionAlerts('local:a')).toBe(0);
    expect(service.acknowledgeSessionAlerts('missing')).toBe(0);
    expect(change).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1);
    expect(service.unreadSessionKeys()).toEqual(['local:b', 'local:c']);
  });

  it('returns the published snapshot without constructing it twice', () => {
    const { service, change, state } = setup();
    const result = service.acknowledgeMany(['a1', 'a1', 'absent']);
    expect(state).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(1);
    expect(change.mock.calls[0]![0]).toBe(result);
    expect(store.update).toHaveBeenCalledTimes(1);
    service.acknowledgeMany(['a1', 'absent']);
    expect(change).toHaveBeenCalledTimes(1);
    expect(store.update).toHaveBeenCalledTimes(1);
  });

  it('does not persist or broadcast unchanged settings, while real changes use one snapshot', () => {
    const { service, change, state } = setup();
    service.setMuted(false);
    service.setNotificationKindEnabled('finished', true);
    expect(change).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    state.mockClear();
    expect(service.setMuted(true)).toBe(change.mock.calls[0]![0]);
    expect(state).toHaveBeenCalledTimes(1);
    expect(service.setNotificationKindEnabled('finished', false)).toBe(change.mock.calls[1]![0]);
    expect(state).toHaveBeenCalledTimes(2);
    expect(store.update).toHaveBeenCalledTimes(2);
    service.setMuted(true);
    service.setNotificationKindEnabled('finished', false);
    expect(change).toHaveBeenCalledTimes(2);
    expect(store.update).toHaveBeenCalledTimes(2);
  });
});
