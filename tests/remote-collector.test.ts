import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
vi.mock('node:child_process', () => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock('../electron/local', () => ({ resolveLocalRoot: () => '/mock',
  scanLocal: vi.fn(async () => []), localScanDiagnostics: () => null }));
import { spawn, execFile } from 'node:child_process';
import { refresh } from '../electron/collector';

const platform = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.restoreAllMocks(); });

describe('WSL and SSH use one conditional parse protocol', () => {
  it('sends scoped hints only on partial scans, delivers metrics, and resets after failure', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      (args.at(-1) as (error: null, stdout: Buffer) => void)(null, Buffer.from('Ubuntu'));
      return {};
    }) as typeof execFile);
    const calls: { command: string; args: readonly string[]; config: Record<string, any> }[] = [];
    let fail = false;
    vi.mocked(spawn).mockImplementation(((command: string, args: readonly string[]) => {
      const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
      const stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
      const stdin = Object.assign(new EventEmitter(), { end(input: string) {
        const encoded = input.match(/CONFIG_B64 = '([^']+)'/)![1]!;
        const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        calls.push({ command, args, config });
        queueMicrotask(() => {
          if (fail) { stderr.emit('data', 'offline'); child.emit('close', 1); return; }
          const now = 1_800_000_000_000, signature = '1:2:100:123:456:33188';
          const common = { id: 'one', rolloutPath: '2026/10/19/rollout-one.jsonl',
            updatedAt: now - 1000, byteSize: 100, title: null, clientKind: 'terminal' };
          const hit = config.scanCache.entries.length > 0;
          const row = hit ? { ...common, _reuse: signature } : { ...common,
            status: 'finished', statusReason: 'log', ageAtSourceMs: 1000, finishedToken: 'done',
            _cache: { signature, from: now, until: now + 60000, title: null, clientKind: 'terminal' } };
          stdout.emit('data', JSON.stringify({ version: 1, rootKey: 'a'.repeat(64), sourceNow: now,
            sessions: [row], metrics: { indexedFiles: 1, statCalls: 1, parsedFiles: hit ? 0 : 1, cacheHits: hit ? 1 : 0 } }));
          child.emit('close', 0);
        });
      } });
      const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: () => true });
      return child;
    }) as typeof spawn);
    const settings = { localRoot: '', wslRoots: {}, remotes: [{ id: 'host', alias: 'host', root: '' }] };
    const selected = new Set(['ssh:host', 'wsl:Ubuntu']);
    const onSource = vi.fn();
    const cold = await refresh(settings, selected, undefined, onSource);
    expect(cold.sources.map(source => source.id)).toEqual(['ssh:host', 'wsl:Ubuntu']);
    expect(calls.map(call => call.command)).toEqual(['ssh', 'wsl.exe']);
    expect(calls.map(call => call.config.scanCache.entries)).toEqual([[], []]);
    expect(onSource).toHaveBeenCalledTimes(2);
    cold.sources[0]!.sessions[0]!.status = 'working';
    const warm = await refresh(settings, selected);
    expect(warm.sources.every(source => source.scanMetrics?.cacheHits === 1)).toBe(true);
    expect(warm.sources.map(source => source.sessions[0]!.key)).toEqual(['ssh:host:one', 'wsl:Ubuntu:one']);
    expect(warm.sources.every(source => source.sessions[0]!.status === 'finished')).toBe(true);
    await refresh(settings); // Manual/periodic all-source scan never sends old parse references.
    expect(calls.slice(-2).every(call => call.config.scanCache.entries.length === 0)).toBe(true);
    fail = true;
    expect((await refresh(settings, new Set(['ssh:host']))).sources[0]!.error).toBe('offline');
    fail = false;
    await refresh(settings, new Set(['ssh:host']));
    expect(calls.at(-1)!.config.scanCache.entries).toEqual([]);
  });
});
