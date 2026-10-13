import { spawn, type ChildProcess } from 'node:child_process';

/** Captures existing Codex HWND geometry BEFORE the official deep link.
 * The isolated helper only corrects that same foreground window if the
 * protocol activation unexpectedly changes its state. No window titles,
 * prompts or private session data are read, emitted or persisted.
 */
const STARTUP_TIMEOUT_MS = 2500;
const FINISH_TIMEOUT_MS = 5500;
type Release = (opened: boolean) => void;

async function prepareWindowGuard(scriptPath: string): Promise<Release | null> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptPath, '-Mode', 'guard',
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    let decided = false;
    let buffer = '';
    const timeout = setTimeout(() => finish(null), STARTUP_TIMEOUT_MS);
    function finish(release: Release | null): void {
      if (decided) return;
      decided = true;
      clearTimeout(timeout);
      if (!release) child.kill();
      resolve(release);
    }
    let exited = false;
    child.once('error', () => finish(null));
    child.once('exit', () => { exited = true; finish(null); });
    if (!child.stdout || !child.stdin) { finish(null); return; }
    // A guard might terminate between its ready message and protocol handoff.
    // An asynchronous EPIPE from end() must not crash the Electron main process.
    child.stdin.on('error', () => { if (!exited) child.kill(); });
    child.stdout.on('data', (data: Buffer) => {
      if (decided) return;
      buffer += data.toString('utf8');
      if (buffer.length > 2048) { finish(null); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      let ready: { type?: unknown; ready?: unknown; observed?: unknown } = {};
      try { ready = JSON.parse(buffer.slice(0, end)); }
      catch { finish(null); return; }
      if (ready.type !== 'desktop-window-guard' || ready.ready !== true ||
          typeof ready.observed !== 'number' || !Number.isInteger(ready.observed) ||
          ready.observed < 0 || ready.observed > 32) { finish(null); return; }
      if (ready.observed === 0) { finish(null); return; }
      finish(opened => {
        if (exited) return;
        const cleanup = setTimeout(() => child.kill(), FINISH_TIMEOUT_MS);
        cleanup.unref?.();
        child.once('exit', () => clearTimeout(cleanup));
        try {
          // No URL is sent to the native helper: Electron still owns
          // the official protocol handoff, so thread routing is unchanged.
          child.stdin?.end(opened ? 'activated\n' : 'cancel\n');
        } catch { child.kill(); }
      });
    });
  });
}

/** A guard failure must never block opening the requested existing thread. */
export async function openDesktopUrlKeepingGeometry(
  url: string, scriptPath: string, openExternal: (url: string) => Promise<void>,
): Promise<void> {
  const release = await prepareWindowGuard(scriptPath);
  try {
    await openExternal(url);
    release?.(true);
  } catch (error) {
    release?.(false);
    throw error;
  }
}
