import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSettingsStore, validateNativeConnections } from '../electron/native-settings';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const row = { sourceId: 'local', enabled: true, transport: 'ws', endpoint: 'ws://127.0.0.1:1234/' };

describe('opt-in native connection settings', () => {
  it('whitelists the saved shape and defaults to no connections', () => {
    expect(new NativeSettingsStore().load()).toEqual([]);
    expect(validateNativeConnections([{ ...row, password: 'discard', token: 'discard' }])).toEqual([row]);
    expect(validateNativeConnections([{ sourceId: 'local', enabled: false, transport: 'auto', endpoint: '' }])).toHaveLength(1);
  });
  it('rejects remote/insecure/credentialed endpoints and nonlocal automatic discovery', () => {
    for (const endpoint of ['ws://192.168.1.2:1234/', 'wss://example.com/', 'ws://user:pass@localhost/',
      'ws://localhost/?token=secret', 'ws://localhost/path', 'ws://localhost/#secret', 'file:///tmp/file', 'ws://localhost/\n'])
      expect(() => validateNativeConnections([{ ...row, endpoint }])).toThrow();
    for (const endpoint of ['relative.sock', '\\\\host\\share\\socket', '//host/socket', '\\\\.\\pipe\\codex'])
      expect(() => validateNativeConnections([{ ...row, transport: 'socket', endpoint }])).toThrow();
    expect(() => validateNativeConnections([{ ...row, sourceId: 'ssh:server', transport: 'auto', endpoint: '' }])).toThrow();
  });
  it('bounds scope and rejects duplicate/unknown identifiers', () => {
    expect(() => validateNativeConnections([row, row])).toThrow();
    expect(() => validateNativeConnections(Array.from({ length: 9 }, (_, i) => ({ ...row, sourceId: 'ssh:' + i })))).toThrow();
    for (const patch of [{ enabled: 'yes' }, { sourceId: 'unknown' }, { sourceId: 'ssh:bad name' }, { transport: 'command' }, { endpoint: 'x'.repeat(2049) }])
      expect(() => validateNativeConnections([{ ...row, ...patch }])).toThrow();
    expect(() => validateNativeConnections(null)).toThrow();
  });
  it('allows several different existing endpoints for one source, rejecting duplicates and keeping the total bound', () => {
    const other = { ...row, endpoint: 'ws://127.0.0.1:2345/' };
    expect(validateNativeConnections([row, other])).toEqual([row, other]);
    expect(() => validateNativeConnections([row, { ...row, endpoint: '  ws://127.0.0.1:1234/  ' }])).toThrow();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-multi-')); roots.push(root);
    const store = new NativeSettingsStore(root); store.save(validateNativeConnections([row, other]));
    expect(store.load()).toEqual([row, other]);
    expect(() => validateNativeConnections(Array.from({ length: 9 }, (_, i) =>
      ({ ...row, endpoint: 'ws://127.0.0.1:' + (3000 + i) + '/' })))).toThrow();
  });
  it('persists only explicit settings atomically and ignores corrupt/oversized legacy data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-settings-')); roots.push(root);
    const store = new NativeSettingsStore(root), connections = validateNativeConnections([row]);
    store.save(connections); expect(store.load()).toEqual(connections);
    expect(fs.existsSync(path.join(root, 'native-connections.json.tmp'))).toBe(false);
    fs.writeFileSync(path.join(root, 'native-connections.json'), 'invalid'); expect(store.load()).toEqual([]);
    fs.writeFileSync(path.join(root, 'native-connections.json'), ' '.repeat(33000)); expect(store.load()).toEqual([]);
    fs.writeFileSync(path.join(root, 'native-connections.json'), JSON.stringify({ version: 2, connections }));
    expect(store.load()).toEqual([]);
  });
});
