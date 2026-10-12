import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { AutoWindowResolver, validForegroundWindow } from '../src/shared/auto-window-binding';
import type { OriginalWindowFocusResult, OriginalWindowStatus, ScanResponse } from '../src/shared/types';

const MAX_LINE_BYTES = 4096;
const SCRIPT_TIMEOUT_MS = 8_000;

/** Observe foreground focus via a long-lived Windows event hook (no polling).
 * Never captures window titles, prompts, tabs, paths, commands or screenshots.
 * A jump is triggered ONLY by an explicit user click on an observed session.
 */
export class AutoWindowTracker {
  private readonly resolver = new AutoWindowResolver();
  private child: ChildProcess | null = null;
  private watching = false;

  private scriptPath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'window-tracker.ps1')
      : path.join(app.getAppPath(), 'collector', 'window-tracker.ps1');
  }

  start(): void {
    if (process.platform !== 'win32' ||
        process.env.CODEX_MONITOR_DISABLE_AUTO_WINDOW_TRACKING === '1' ||
        this.child) return;
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath(), '-Mode', 'watch',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    this.watching = true;
    let buffer = '';
    child.stdout?.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES * 4) { buffer = ''; return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line.length > MAX_LINE_BYTES || !line) continue;
        try {
          const raw: unknown = JSON.parse(line);
          if (raw && typeof raw === 'object' && 'type' in raw &&
              raw.type === 'foreground' && validForegroundWindow(raw)) {
            this.resolver.observeFocus(raw);
          }
        } catch { /* Never log raw OS output or window content. */ }
      }
    });
    child.on('error', () => {
      this.watching = false;
      console.warn('Original-window observer could not start');
    });
    child.on('exit', () => {
      this.watching = false;
      if (this.child === child) this.child = null;
    });
  }

  stop(): void {
    this.watching = false;
    this.child?.kill();
    this.child = null;
    this.resolver.clear();
  }

  observeScan(snapshot: ScanResponse): void {
    if (this.watching) this.resolver.observeScan(snapshot);
  }

  status(sessionKey: string): OriginalWindowStatus {
    if (process.platform !== 'win32') return {
      ready: false, message: '原窗口自动定位仅支持 Windows Monitor',
    };
    if (process.env.CODEX_MONITOR_DISABLE_AUTO_WINDOW_TRACKING === '1') return {
      ready: false, message: '原窗口自动定位已通过环境变量停用',
    };
    if (!this.watching) return {
      ready: false, message: 'Windows 窗口监听不可用；未建立自动关联',
    };
    const found = this.resolver.get(sessionKey);
    return found ? {
      ready: true, host: found.app === 'other' ? undefined : found.app,
      message: '已根据最近一次用户输入自动关联原窗口（不保证切换到正确标签）',
    } : {
      ready: false,
      message: '尚无可靠的原窗口关联；从原 Codex 窗口再次发送消息后会尝试自动识别',
    };
  }

  async focusOriginalWindow(sessionKey: string): Promise<OriginalWindowFocusResult> {
    const info = this.status(sessionKey);
    if (!info.ready) return {
      state: this.watching ? 'unbound' : 'unavailable', message: info.message,
    };
    const target = this.resolver.get(sessionKey);
    if (!target) return { state: 'unbound', message: '原窗口尚未关联' };
    const command = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', this.scriptPath(), '-Mode', 'focus',
      '-WindowHandle', target.hwnd, '-TargetPid', String(target.pid),
      '-ProcessStart', String(target.startedAt),
    ];
    return new Promise<OriginalWindowFocusResult>(resolve => {
      execFile('powershell.exe', command, {
        windowsHide: true, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 32 * 1024,
      }, (error, stdout) => {
        if (error) return resolve({
          state: 'unavailable', message: 'Windows 原窗口激活组件不可用',
        });
        let result: { ok?: boolean; reason?: string } = {};
        try { result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}'); }
        catch { /* Failed native result. */ }
        if (result.ok === true) return resolve({
          state: 'focused', message: '已切换至自动识别的原窗口（未切换内部标签）',
        });
        if (['stale_window', 'process_changed', 'invalid_or_stale_window'].includes(result.reason || '')) {
          this.resolver.invalidate(sessionKey);
          return resolve({ state: 'stale', message: '原窗口已关闭或进程已变化；等待下一次输入重新识别' });
        }
        resolve({ state: 'blocked', message: 'Windows 未允许该次窗口激活；原窗口关联仍保留' });
      });
    });
  }
}
