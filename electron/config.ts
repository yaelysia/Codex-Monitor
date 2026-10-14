import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { Settings } from '../src/shared/types';

const emptySettings = (): Settings => ({ localRoot: '', wslRoots: {}, remotes: [] });
const fileName = () => path.join(app.getPath('userData'), 'monitor-settings.json');
const validText = (value: unknown, max = 1024): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const validAlias = (alias: string): boolean =>
  alias.length > 0 && !alias.startsWith('-') && /^[a-zA-Z0-9_.:@-]+$/.test(alias);

/** Validate everything at the IPC boundary; user settings never become arbitrary process arguments. */
export function normalizeSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid settings');
  const settings = raw as Record<string, unknown>;
  const root = validText(settings.localRoot);
  const wslRoots: Record<string, string> = Object.create(null);
  if (settings.wslRoots && typeof settings.wslRoots === 'object' && !Array.isArray(settings.wslRoots)) {
    for (const [distro, value] of Object.entries(settings.wslRoots)) {
      if (distro.length <= 100 && distro !== '__proto__') wslRoots[distro] = validText(value);
    }
  }
  if (!Array.isArray(settings.remotes) || settings.remotes.length > 20) {
    throw new Error('Remote hosts must be a list of up to 20 entries');
  }
  const seen = new Set<string>();
  const remotes = settings.remotes.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid remote host');
    const row = item as Record<string, unknown>;
    const alias = validText(row.alias, 255);
    if (!validAlias(alias) || seen.has(alias)) throw new Error(`Invalid or duplicate SSH alias: ${alias}`);
    seen.add(alias);
    const id = validText(row.id, 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid remote source ID');
    return { id, alias, root: validText(row.root) };
  });
  if (new Set(remotes.map((host) => host.id)).size !== remotes.length) throw new Error('Duplicate remote source ID');
  return { localRoot: root, wslRoots, remotes };
}

export async function readSettings(): Promise<Settings> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileName(), 'utf8'));
    return normalizeSettings(parsed);
  } catch {
    return emptySettings();
  }
}

export async function writeSettings(settings: Settings): Promise<Settings> {
  const validated = normalizeSettings(settings);
  await fs.mkdir(path.dirname(fileName()), { recursive: true });
  const tmp = `${fileName()}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(validated, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tmp, fileName());
  } finally { await fs.rm(tmp, { force: true }).catch(() => undefined); }
  return validated;
}
