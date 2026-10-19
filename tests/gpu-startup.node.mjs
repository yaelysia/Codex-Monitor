import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureGpuStartup, gpuConfigPath, readGpuMode, saveGpuMode } from '../scripts/runtime/gpu-startup.mjs';
import { configureGpuCli } from '../scripts/configure-gpu.mjs';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-monitor-gpu-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}
function runtime(root, ready = false) {
  const calls = [], logs = [];
  const app = {
    isReady: () => ready,
    getPath: name => { assert.equal(name, 'appData'); calls.push('path'); return root; },
    disableHardwareAcceleration: () => calls.push('software'),
    commandLine: { appendSwitch: flag => calls.push(flag) },
  };
  return { app, calls, logs, apply: (env = {}, platform = 'win32') =>
    configureGpuStartup(app, { env, platform, log: message => logs.push(message) }) };
}

test('no config keeps the default sandbox and hardware policy without creating files', t => {
  const root = directory(t), r = runtime(root);
  assert.deepEqual(r.apply(), { mode: 'default', source: 'default' });
  assert.deepEqual(r.calls, ['path']);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('an explicit compat choice persists across independent launches and is reversible', t => {
  const root = directory(t);
  saveGpuMode(root, 'compat');
  for (let i = 0; i < 2; i++) {
    const r = runtime(root);
    assert.deepEqual(r.apply(), { mode: 'compat', source: 'saved' });
    assert.deepEqual(r.calls, ['path', 'disable-gpu-sandbox']);
    assert.match(r.logs.join('\n'), /explicit opt-in/);
  }
  saveGpuMode(root, 'default');
  const r = runtime(root);
  assert.equal(r.apply().mode, 'default');
  assert.deepEqual(r.calls, ['path']);
  assert.deepEqual(fs.readdirSync(path.dirname(gpuConfigPath(root))), ['startup-gpu.json']);
});

test('software rendering does not disable any sandbox', t => {
  const root = directory(t), r = runtime(root);
  saveGpuMode(root, 'software');
  assert.equal(r.apply().mode, 'software');
  assert.deepEqual(r.calls, ['path', 'software']);
});

test('legacy 1 and 0 environment overrides are temporary and never written back', t => {
  const root = directory(t);
  saveGpuMode(root, 'software');
  for (const [value, expected, calls] of [['1', 'compat', ['disable-gpu-sandbox']], ['0', 'default', []]]) {
    const r = runtime(root);
    assert.equal(r.apply({ CODEX_MONITOR_DISABLE_GPU_SANDBOX: value }).mode, expected);
    assert.deepEqual(r.calls, calls);
    assert.equal(readGpuMode(root).mode, 'software');
  }
});

test('non-Windows platforms do not load or apply Windows opt-ins', () => {
  for (const platform of ['linux', 'darwin']) {
    const r = runtime('unused');
    assert.equal(r.apply({ CODEX_MONITOR_DISABLE_GPU_SANDBOX: '1' }, platform).source, 'platform');
    assert.deepEqual(r.calls, []);
  }
});

test('invalid config fails closed without silently disabling GPU isolation', t => {
  const root = directory(t), file = gpuConfigPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['{', 'null', '{}', '{"version":2,"mode":"compat"}',
    '{"version":1,"mode":"no-sandbox"}', ' '.repeat(5000)]) {
    fs.writeFileSync(file, text);
    const r = runtime(root);
    assert.equal(r.apply().mode, 'default');
    assert.deepEqual(r.calls, ['path']);
    assert.match(r.logs.join('\n'), /unreadable/);
  }
});

test('unavailable application data and a directory in place of config keep defaults', t => {
  const root = directory(t);
  fs.mkdirSync(gpuConfigPath(root), { recursive: true });
  assert.match(readGpuMode(root).warning, /unreadable/);
  const r = runtime(root);
  r.app.getPath = () => { throw new Error('unavailable'); };
  assert.equal(r.apply().mode, 'default');
  assert.deepEqual(r.calls, []);
});

test('invalid writes and relative paths do not alter a saved choice', t => {
  const root = directory(t);
  saveGpuMode(root, 'compat');
  assert.throws(() => saveGpuMode(root, 'no-sandbox'), /GPU mode/);
  assert.throws(() => gpuConfigPath('relative-directory'), /absolute/);
  assert.throws(() => gpuConfigPath(undefined), /absolute/);
  assert.equal(readGpuMode(root).mode, 'compat');
});

test('configuration cannot be applied after ready', t => {
  const r = runtime(directory(t), true);
  assert.throws(() => r.apply(), /before Electron ready/);
  assert.deepEqual(r.calls, []);
});

test('CLI saves for a fresh shell, reports status and resets without launching Electron', t => {
  const root = directory(t), logs = [], env = { APPDATA: root };
  const options = { platform: 'win32', env, log: line => logs.push(line) };
  assert.equal(configureGpuCli(['compat'], options), 0);
  assert.match(logs.join('\n'), /reducing GPU process isolation/);
  assert.equal(runtime(root).apply().mode, 'compat');
  assert.equal(configureGpuCli(['status'], options), 0);
  assert.match(logs.join('\n'), /compat \(saved\)/);
  assert.equal(configureGpuCli(['default'], options), 0);
  assert.equal(runtime(root).apply().mode, 'default');
});

test('CLI rejects unsupported platform, bad arguments or missing APPDATA without writing', t => {
  const root = directory(t), log = () => {};
  assert.equal(configureGpuCli(['compat'], { platform: 'linux', env: { APPDATA: root }, log }), 1);
  assert.equal(configureGpuCli(['compat', 'extra'], { platform: 'win32', env: { APPDATA: root }, log }), 1);
  assert.equal(configureGpuCli(['compat'], { platform: 'win32', env: {}, log }), 1);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('CLI reports an overriding environment and unreadable saved settings', t => {
  const root = directory(t), logs = [], options = { platform: 'win32',
    env: { APPDATA: root, CODEX_MONITOR_DISABLE_GPU_SANDBOX: '0' }, log: line => logs.push(line) };
  assert.equal(configureGpuCli(['compat'], options), 0);
  assert.match(logs.join('\n'), /override is active \(0\)/);
  fs.writeFileSync(gpuConfigPath(root), '{');
  assert.equal(configureGpuCli(['status'], options), 1);
});
