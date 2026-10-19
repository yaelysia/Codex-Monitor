import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const moduleUrl = new URL('../scripts/runtime/gpu-startup.mjs', import.meta.url).href;
const cli = fileURLToPath(new URL('../scripts/configure-gpu.mjs', import.meta.url));

// A real Electron process and renderer, but NOT the Monitor application: no
// watchers, Codex data, network pages, window switching or installed app changes.
const main = `import assert from 'node:assert/strict';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { configureGpuStartup } from ${JSON.stringify(moduleUrl)};
app.setPath('appData', process.env.CM_GPU_TEST_DATA);
app.setPath('userData', path.join(process.env.CM_GPU_TEST_DATA, 'fixture'));
app.setPath('sessionData', path.join(process.env.CM_GPU_TEST_DATA, 'fixture'));
assert.equal(app.isReady(), false);
const choice = configureGpuStartup(app);
assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
assert.equal(app.commandLine.hasSwitch('disable-gpu-sandbox'), choice.mode === 'compat');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 200,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><p id="ready">ready</p>'));
  const isolated = await win.webContents.executeJavaScript(
    'document.getElementById("ready").textContent === "ready" && typeof process === "undefined" && typeof require === "undefined"');
  assert.equal(isolated, true);
  const prefs = win.webContents.getLastWebPreferences();
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  const image = await win.webContents.capturePage();
  assert.equal(image.isEmpty(), false);
  console.log('CM_GPU_SMOKE:' + JSON.stringify({ mode: choice.mode, sandbox: prefs.sandbox,
    rendererLoaded: isolated, captured: !image.isEmpty() }));
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`;

test('real Windows Electron renders with persisted GPU modes, including a fresh-shell relaunch', {
  skip: process.platform !== 'win32' ? 'Windows GPU startup smoke; Linux has separate bundle/config tests' : false,
  timeout: 150000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codex-monitor-gpu-electron-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  await mkdir(path.join(root, 'fixture'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'gpu-smoke-fixture', type: 'module', main: 'main.mjs' }));
  await writeFile(path.join(root, 'main.mjs'), main);
  const env = { ...process.env, APPDATA: root, CM_GPU_TEST_DATA: root };
  delete env.CODEX_MONITOR_DISABLE_GPU_SANDBOX;
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = createRequire(import.meta.url)('electron');
  // Each CLI invocation exits before Electron starts; no inherited compatibility
  // switch. The repeated compat launch reuses the same saved choice unchanged.
  let previous;
  for (const mode of ['default', 'software', 'compat', 'compat', 'default']) {
    if (mode !== previous) await exec(process.execPath, [cli, mode], { env, timeout: 10000, windowsHide: true });
    const result = await exec(electron, [root], { env, timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('CM_GPU_SMOKE:'));
    assert.ok(line, `Missing renderer success marker (${mode}): ${result.stderr.slice(-2000)}`);
    assert.deepEqual(JSON.parse(line.slice('CM_GPU_SMOKE:'.length)), {
      mode, sandbox: true, rendererLoaded: true, captured: true,
    });
    assert.doesNotMatch(result.stderr, /GPU process isn't usable/);
    previous = mode;
  }
});
