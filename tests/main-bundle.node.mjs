import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire, isBuiltin, Module } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import test from 'node:test';
import { resolveConfig } from 'electron-vite';
import { build as viteBuild } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

/** Load the actual emitted CommonJS entry. Only Electron is mocked: denying
 * the instance lock avoids opening windows, reading user data or starting
 * collectors. Every non-Electron import must resolve from the isolated app.
 */
async function loadMain(entry) {
  const runtimeRequire = createRequire(entry);
  for (const name of ['bufferutil', 'utf-8-validate']) {
    assert.throws(() => runtimeRequire.resolve(name), { code: 'MODULE_NOT_FOUND' },
      `${name} must be absent for this regression`);
  }
  let lockChecks = 0, quits = 0, transport;
  const electron = { app: {
    commandLine: { appendSwitch() {} },
    setAppUserModelId() {},
    requestSingleInstanceLock() { lockChecks++; return false; },
    quit() { quits++; },
    on() {},
  } };
  const compiled = runInThisContext(Module.wrap(await readFile(entry, 'utf8')), { filename: entry });
  const module = { exports: {} };
  compiled.call(module.exports, module.exports, id => {
    if (id === 'electron') return electron;
    assert.ok(isBuiltin(id) || id === 'ws', `Unexpected runtime import: ${id}`);
    const value = runtimeRequire(id);
    if (id === 'ws') transport = value;
    return value;
  }, module, entry, path.dirname(entry));
  assert.equal(lockChecks, 1, 'main entry must reach the Electron lifecycle');
  assert.equal(quits, 1, 'smoke load must stop before application services start');
  assert.ok(transport, 'main must load ws from its declared runtime dependency');
  return transport;
}

/** Exercise the exact ws module loaded by the emitted main, without optional
 * native accelerators. Large masked text and binary frames use its JS fallback.
 */
async function roundTrip(WebSocket) {
  const server = new WebSocket.WebSocketServer({ host: '127.0.0.1', port: 0,
    perMessageDeflate: false });
  let client;
  try {
    server.on('connection', peer => {
      peer.on('error', () => {});
      peer.on('message', (bytes, isBinary) => peer.send(bytes, { binary: isBinary }));
    });
    await once(server, 'listening', { signal: AbortSignal.timeout(5000) });
    client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`, {
      perMessageDeflate: false, handshakeTimeout: 5000,
    });
    await once(client, 'open', { signal: AbortSignal.timeout(5000) });
    for (const payload of ['native-state-中文-'.repeat(128), Buffer.alloc(4096, 0xa5)]) {
      const received = once(client, 'message', { signal: AbortSignal.timeout(5000) });
      client.send(payload);
      const [bytes, isBinary] = await received;
      assert.equal(isBinary, Buffer.isBuffer(payload));
      assert.deepEqual(bytes, Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
    }
  } finally {
    client?.terminate();
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const mode of ['development', 'production']) {
  test(`${mode} main loads with production ws and no native addons`, { timeout: 60000 }, async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-monitor-startup-'));
    t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 3 }));
    const names = ['NODE_ENV', 'NODE_ENV_ELECTRON_VITE', 'WS_NO_BUFFER_UTIL', 'WS_NO_UTF_8_VALIDATE'];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    t.after(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    process.env.NODE_ENV = mode;
    process.env.NODE_ENV_ELECTRON_VITE = mode;
    delete process.env.WS_NO_BUFFER_UTIL;
    delete process.env.WS_NO_UTF_8_VALIDATE;

    // Match electron-vite dev's serve/development resolution, not just a
    // production build with a different label. Do not launch Electron or Vite's server.
    const { config } = await resolveConfig({ root, logLevel: 'warn' },
      mode === 'development' ? 'serve' : 'build', mode);
    assert.ok(config?.main);
    await viteBuild({ ...config.main, build: { ...config.main.build,
      outDir: path.join(temporary, 'out/main'), watch: null,
    } });

    // Stage only the declared main-process runtime dependency, outside the
    // repository. No access to the project's devDependencies or native addons.
    if (manifest.dependencies?.ws) {
      const deployed = path.join(temporary, 'node_modules/ws');
      await mkdir(path.dirname(deployed), { recursive: true });
      const installed = path.dirname(require.resolve('ws/package.json'));
      await cp(installed, deployed, { recursive: true,
        filter: source => !path.relative(installed, source).split(path.sep).includes('node_modules'),
      });
    }
    const transport = await loadMain(path.join(temporary, manifest.main));
    await roundTrip(transport);
  });
}
