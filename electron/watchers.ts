import fs from 'node:fs';
import { promises as files } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { app } from 'electron';
import type { Settings, SourceResult } from '../src/shared/types';
import { resolveLocalRoot } from './local';

export type EventChannelMode = 'active' | 'connecting' | 'fallback';
type SourceWatch = { fingerprint: string; dispose(): void };
interface WatchSpec {
  id: string;
  kind: 'local' | 'wsl' | 'ssh';
  fingerprint: string;
  root: string;
  alias?: string;
  distro?: string;
}

let cachedScript: Promise<string> | null = null;
function linuxWatchScript(): Promise<string> {
  if (!cachedScript) {
    const file = app.isPackaged
      ? path.join(process.resourcesPath, 'watch.py')
      : path.join(app.getAppPath(), 'collector', 'watch.py');
    cachedScript = files.readFile(file, 'utf8').catch(error => {
      cachedScript = null;
      throw error;
    });
  }
  return cachedScript;
}

/** The only remote payload is a tiny "change" signal, never session text or file paths. */
export function parseWatcherSignal(line: string): 'ready' | 'change' | 'heartbeat' | null {
  if (!line || line.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const kind = (value as { kind?: unknown }).kind;
    return kind === 'ready' || kind === 'change' || kind === 'heartbeat' ? kind : null;
  } catch { return null; }
}

/** Event notifications supplement the 12-second polling safety net.
 * Watchers are only attached to Codex's own session directories, never workspaces. */
export class WatchCoordinator {
  private watches = new Map<string, SourceWatch>();
  private statuses = new Map<string, EventChannelMode>();
  private stopped = true;

  constructor(private readonly onChange: (sourceId: string) => void,
    private readonly onHealth?: () => void) {}

  status(): Record<string, EventChannelMode> {
    return Object.fromEntries(this.statuses);
  }

  private statusFor(id: string, mode: EventChannelMode): void {
    if (this.stopped || this.statuses.get(id) === mode) return;
    this.statuses.set(id, mode);
    this.onHealth?.();
  }

  start(): void { this.stopped = false; }

  stop(): void {
    this.stopped = true;
    for (const watch of this.watches.values()) watch.dispose();
    this.watches.clear();
    this.statuses.clear();
  }

  reconcile(settings: Settings, sources: SourceResult[]): void {
    if (this.stopped) return;
    const requested = new Map<string, WatchSpec>();
    for (const source of sources) {
      if (source.kind === 'local') {
        const root = resolveLocalRoot(settings.localRoot);
        requested.set(source.id, { id: source.id, kind: 'local', root,
          fingerprint: JSON.stringify(['local', root]) });
      } else if (source.kind === 'wsl' && source.id.startsWith('wsl:')) {
        const distro = source.id.slice(4);
        const root = settings.wslRoots[distro] || '';
        requested.set(source.id, { id: source.id, kind: 'wsl', distro, root,
          fingerprint: JSON.stringify(['wsl', distro, root]) });
      } else if (source.kind === 'ssh') {
        const host = settings.remotes.find(item => 'ssh:' + item.id === source.id);
        if (host) requested.set(source.id, { id: source.id, kind: 'ssh',
          alias: host.alias, root: host.root,
          fingerprint: JSON.stringify(['ssh', host.alias, host.root]) });
      }
    }

    for (const [id, existing] of this.watches) {
      if (requested.get(id)?.fingerprint !== existing.fingerprint) {
        existing.dispose();
        this.watches.delete(id);
        this.statuses.delete(id);
      }
    }
    for (const [id, spec] of requested) {
      if (this.watches.has(id)) continue;
      this.watches.set(id, spec.kind === 'local'
        ? this.local(spec) : this.remote(spec));
    }
  }

  private local(spec: WatchSpec): SourceWatch {
    let alive = true;
    let watch: fs.FSWatcher | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const launch = () => {
      if (!alive || this.stopped) return;
      try {
        watch = fs.watch(path.join(spec.root, 'sessions'),
          { recursive: true, persistent: false }, (kind, filename) => {
            if (!alive || this.stopped) return;
            const name = filename?.toString();
            // A rename may be a new date folder; a null filename means rescan safely.
            if (!name || name.endsWith('.jsonl') || kind === 'rename') this.onChange(spec.id);
          });
        this.statusFor(spec.id, 'active');
        watch.on('error', () => {
          watch?.close();
          watch = null;
          this.statusFor(spec.id, 'fallback');
          scheduleRetry();
        });
      } catch {
        this.statusFor(spec.id, 'fallback');
        scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      if (!alive || this.stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        this.statusFor(spec.id, 'connecting');
        launch();
      }, 30_000);
      retry.unref?.();
    };
    launch();
    return {
      fingerprint: spec.fingerprint,
      dispose: () => {
        alive = false;
        if (retry) clearTimeout(retry);
        watch?.close();
      },
    };
  }

  private remote(spec: WatchSpec): SourceWatch {
    let alive = true;
    let child: ChildProcessWithoutNullStreams | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    this.statusFor(spec.id, 'connecting');

    const scheduleRetry = () => {
      if (!alive || this.stopped || retry) return;
      const delay = Math.min(60_000, 4_000 * (2 ** Math.min(4, failures++)));
      this.statusFor(spec.id, 'fallback');
      retry = setTimeout(() => {
        retry = null;
        this.statusFor(spec.id, 'connecting');
        void launch();
      }, delay);
      retry.unref?.();
    };

    const launch = async () => {
      if (!alive || this.stopped) return;
      let program: string;
      try { program = await linuxWatchScript(); }
      catch {
        scheduleRetry();
        return;
      }
      if (!alive || this.stopped) return;
      const args = spec.kind === 'wsl'
        ? ['-d', spec.distro!, '--', 'python3', '-u', '-']
        : ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
          '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=20',
          '-o', 'ServerAliveCountMax=3', spec.alias!, 'python3', '-u', '-'];
      const command = spec.kind === 'wsl' ? 'wsl.exe' : 'ssh';
      const proc = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = proc;
      let buffer = '';
      let ready = false;
      let lastSignalAt = Date.now();
      const watchdog = setInterval(() => {
        // The transient Python stream sends a heartbeat every 25 seconds.
        if (ready && Date.now() - lastSignalAt > 85_000) proc.kill();
      }, 30_000);
      watchdog.unref?.();
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (data: string) => {
        if (!alive || this.stopped) return;
        buffer += data;
        // Protect the main process from accidental unbounded/malformed stdout.
        if (buffer.length > 32_768) { proc.kill(); return; }
        let pos: number;
        while ((pos = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, pos).trim();
          buffer = buffer.slice(pos + 1);
          const kind = parseWatcherSignal(line);
          if (kind) lastSignalAt = Date.now();
          if (kind === 'ready') {
            ready = true;
            failures = 0;
            this.statusFor(spec.id, 'active');
          }
          if (kind === 'change' && ready) this.onChange(spec.id);
        }
      });
      // Deliberately never relay remote stderr or user-configured paths into notifications.
      proc.stderr.resume();
      proc.once('error', () => { /* close handles reconnect or fallback */ });
      proc.once('close', () => {
        clearInterval(watchdog);
        if (child === proc) child = null;
        if (alive && !this.stopped) scheduleRetry();
      });
      const options = Buffer.from(JSON.stringify({ root: spec.root }), 'utf8').toString('base64');
      proc.stdin.on('error', () => { /* process close will reconnect */ });
      proc.stdin.end("CONFIG_B64 = '" + options + "'\n" + program);
    };
    void launch();
    return {
      fingerprint: spec.fingerprint,
      dispose: () => {
        alive = false;
        if (retry) clearTimeout(retry);
        child?.kill();
        child = null;
      },
    };
  }
}
