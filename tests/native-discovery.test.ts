import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverKnownLocalSocket } from '../electron/native-discovery';

const paths: string[] = [];
afterEach(async () => {
  for (const root of paths.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
describe('explicit local-only known control socket discovery', () => {
  it('does not scan arbitrary paths or connect when the known socket is absent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'known-native-')); paths.push(root);
    expect(await discoverKnownLocalSocket(root)).toEqual({ state: 'not-found' });
    expect(await discoverKnownLocalSocket('relative')).toEqual({ state: 'unsafe' });
  });
  it('reports a candidate file without claiming it is a live protocol socket', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'known-native-')); paths.push(root);
    const dir = path.join(root, 'app-server-control');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'app-server-control.sock'), 'not-an-app-server');
    expect(await discoverKnownLocalSocket(root)).toEqual({ state: 'candidate-found' });
  });
  it.skipIf(process.platform === 'win32')('rejects symlinks that escape the configured CODEX_HOME', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'known-native-')); paths.push(root);
    const dir = path.join(root, 'app-server-control'); await fs.mkdir(dir);
    const outside = path.join(root, 'outside'); await fs.writeFile(outside, '');
    await fs.symlink(outside, path.join(dir, 'app-server-control.sock'));
    expect(await discoverKnownLocalSocket(root)).toEqual({ state: 'unsafe' });
  });
});
