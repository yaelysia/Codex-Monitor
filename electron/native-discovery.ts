import fs from 'node:fs/promises';
import path from 'node:path';
import type { NativeLocalDiscovery } from '../src/shared/native-state';

/** A user-invoked existence check for exactly one documented local control
 * socket; no TCP/port scan, credentials, process enumeration or connections.
 * The result is NOT proof of App Server bookability / protocol compatibility.
 */
export async function discoverKnownLocalSocket(root: string): Promise<NativeLocalDiscovery> {
  if (!path.isAbsolute(root) || /^[\\/]{2}/.test(root))
    return { state: 'unsafe' };
  const candidate = path.join(root, 'app-server-control', 'app-server-control.sock');
  try {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || (!stat.isSocket() && !stat.isFile()))
      return { state: 'unsafe' };
    const home = await fs.realpath(root);
    const actual = await fs.realpath(candidate);
    const rel = path.relative(home, actual);
    if (rel !== path.join('app-server-control', 'app-server-control.sock') ||
        rel.startsWith('..') || path.isAbsolute(rel)) return { state: 'unsafe' };
    return { state: stat.isSocket() ? 'socket-found' : 'candidate-found' };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'not-found' : 'inaccessible' };
  }
}
