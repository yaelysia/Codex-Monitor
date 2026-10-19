import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const GPU_MODES = Object.freeze(['default', 'software', 'compat']);
const MAX_CONFIG_BYTES = 4096;

// Fixed per-user location: development, packaged builds and new checkouts share
// the choice. Never write into the checkout, Codex data or the global environment.
export function gpuConfigPath(appData) {
  if (typeof appData !== 'string' || !path.isAbsolute(appData))
    throw new Error('An absolute Windows application-data directory is required');
  return path.join(appData, 'codex-monitor', 'startup-gpu.json');
}

export function readGpuMode(appData) {
  let fd;
  try {
    fd = fs.openSync(gpuConfigPath(appData), 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new Error('Invalid GPU config');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_CONFIG_BYTES) throw new Error('Oversized GPU config');
    const saved = JSON.parse(bytes.toString('utf8', 0, length).replace(/^\uFEFF/, ''));
    if (saved?.version !== 1 || !GPU_MODES.includes(saved.mode)) throw new Error('Invalid GPU config');
    return { mode: saved.mode, source: 'saved' };
  } catch (error) {
    return { mode: 'default', source: 'default',
      ...(error?.code === 'ENOENT' ? {} : { warning: 'GPU settings unreadable; using sandboxed defaults' }) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function saveGpuMode(appData, mode) {
  if (!GPU_MODES.includes(mode)) throw new Error('GPU mode must be default, software or compat');
  const file = gpuConfigPath(appData);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, mode }) + '\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

/** Synchronous, before ready: Chromium startup flags cannot be applied later.
 * Compatibility deliberately relaxes ONLY the GPU sandbox, on explicit opt-in.
 * An environment override is temporary and never silently changes the saved mode.
 */
export function configureGpuStartup(app, { platform = process.platform, env = process.env,
  log = console.warn } = {}) {
  if (platform !== 'win32') return { mode: 'default', source: 'platform' };
  if (app.isReady()) throw new Error('GPU startup configuration must run before Electron ready');
  const override = env.CODEX_MONITOR_DISABLE_GPU_SANDBOX;
  let choice;
  if (override === '1' || override === '0') {
    choice = { mode: override === '1' ? 'compat' : 'default', source: 'environment' };
  } else {
    try { choice = readGpuMode(app.getPath('appData')); }
    catch { choice = { mode: 'default', source: 'default', warning: 'GPU settings unavailable' }; }
  }
  if (choice.mode === 'software') app.disableHardwareAcceleration();
  if (choice.mode === 'compat') app.commandLine.appendSwitch('disable-gpu-sandbox');
  log(`[Codex Monitor] GPU startup: ${choice.mode} (${choice.source})`);
  if (choice.warning) log(`[Codex Monitor] ${choice.warning}`);
  if (choice.mode === 'compat')
    log('[Codex Monitor] GPU sandbox disabled by explicit opt-in; renderer sandbox settings unchanged');
  return choice;
}
