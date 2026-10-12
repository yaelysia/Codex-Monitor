import { app } from 'electron';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { AutoWindowResolver, normalizeForegroundWindow } from '../src/shared/auto-window-binding';
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
  private stopRequested = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;
  private lastNativeError: string | null = null;

  constructor(private readonly platform = process.platform) {}

  private scriptPath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'window-tracker.ps1')
      : path.join(app.getAppPath(), 'collector', 'window-tracker.ps1');
  }

  start(): void {
    if (this.platform !== 'win32' ||
        process.env.CODEX_MONITOR_DISABLE_AUTO_WINDOW_TRACKING === '1') return;
    this.stopRequested = false;
    this.launch();
  }

  private clearStartupTimer(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private restart(): void {
    if (this.stopRequested || this.restartTimer ||
        this.platform !== 'win32' || this.restartCount >= 6) return;
    const backoff = [2000, 5000, 10000, 20000, 30000, 30000][this.restartCount]!;
    this.restartCount++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, backoff);
  }

  private launch(): void {
    if (this.stopRequested || this.child) return;
    let child: ChildProcess;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath(), '-Mode', 'watch',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      this.lastNativeError = 'observer_launch_failed';
      this.restart();
      return;
    }
    this.child = child;
    this.watching = false;
    let received = false;
    let exited = false;
    let buffer = '';

    const shutdown = () => {
      if (exited) return;
      exited = true;
      this.clearStartupTimer();
      if (this.child !== child) return;
      this.child = null;
      this.watching = false;
      // Focus gaps invalidate association timing. Never retain stale history
      // across an observer restart, but keep any Codex session data unaffected.
      this.resolver.clear();
      if (!this.stopRequested) this.restart();
    };

    // PowerShell/native assembly compilation is not an indication that hooks
    // actually produced foreground samples. Restart if none arrives.
    this.startupTimer = setTimeout(() => {
      if (this.child !== child || received) return;
      this.lastNativeError = 'observer_startup_timeout';
      child.kill();
      shutdown();
    }, 20_000);

    child.stdout?.on('data', (bytes: Buffer) => {
      if (exited) return;
      buffer += bytes.toString('utf8');
      if (buffer.length > MAX_LINE_BYTES * 4) { buffer = ''; return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line.length > MAX_LINE_BYTES || !line) continue;
        try {
          const raw: unknown = JSON.parse(line);
          if (!raw || typeof raw !== 'object' || !('type' in raw)) continue;
          if (raw.type === 'foreground') {
            const foreground = normalizeForegroundWindow(raw);
            if (!foreground) continue;
            if (!received) {
              received = true;
              this.watching = true;
              this.restartCount = 0;
              this.lastNativeError = null;
              this.clearStartupTimer();
            }
            this.resolver.observeFocus(foreground);
          } else if ('ok' in raw && raw.ok === false &&
              'reason' in raw && raw.reason === 'native_bridge_unavailable') {
            this.lastNativeError = 'native_bridge_unavailable';
          }
        } catch { /* Only parsed whitelist fields are used, no raw logs. */ }
      }
    });
    child.on('error', () => {
      this.lastNativeError = 'observer_process_error';
      console.warn('Windows original-window observer could not start; retrying');
      shutdown();
    });
    child.on('exit', () => {
      if (!received && !this.lastNativeError) this.lastNativeError = 'observer_exited_early';
      shutdown();
    });
  }

  stop(): void {
    this.stopRequested = true;
    this.clearStartupTimer();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.watching = false;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.resolver.clear();
  }

  observeScan(snapshot: ScanResponse): void {
    if (this.watching) this.resolver.observeScan(snapshot);
  }

  status(sessionKey: string): OriginalWindowStatus {
    if (this.platform !== 'win32') return {
      ready: false, message: '原窗口自动定位仅支持 Windows Monitor',
    };
    if (process.env.CODEX_MONITOR_DISABLE_AUTO_WINDOW_TRACKING === '1') return {
      ready: false, message: '原窗口自动定位已通过环境变量停用',
    };
    const found = this.resolver.get(sessionKey);
    // Existing HWND evidence remains usable if the hook temporarily fails:
    // native focus will independently validate the HWND, PID and start time.
    if (!this.watching && !found) return {
      ready: false,
      message: this.restartCount >= 6
        ? 'Windows 原窗口监听连续失败，请检查 PowerShell/原生组件'
        : 'Windows 原窗口监听正在恢复，请在原会话重新发送一次消息',
    };
    return found ? {
      ready: true, host: found.app === 'other' ? undefined : found.app,
      message: found.tabId ? '已自动关联原窗口及原标签（待实机验证）' :
        (found.tabCount != null && found.tabCount > 1) ||
          (found.tabHost === 'multi' && !found.tabId)
          ? '已关联原窗口，但多标签位置尚无可靠证据'
          : '已关联原窗口（无法确认内部标签或 VS Code 对话）',
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
      ...(target.tabId ? ['-TabId', target.tabId] : []),
    ];
    return new Promise<OriginalWindowFocusResult>(resolve => {
      execFile('powershell.exe', command, {
        windowsHide: true, timeout: SCRIPT_TIMEOUT_MS, maxBuffer: 32 * 1024,
      }, (error, stdout) => {
        if (error) return resolve({
          state: 'unavailable', message: 'Windows 原窗口激活组件不可用',
        });
        let result: { ok?: boolean; reason?: string; windowFocused?: boolean; tabFocused?: boolean } = {};
        try { result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || '{}'); }
        catch { /* Failed native result. */ }
        if (result.ok === true) {
          if (!target.tabId && ((target.tabCount ?? 0) > 1 ||
              target.tabHost === 'multi')) return resolve({
            state: 'partial',
            message: '已返回原窗口，但无法确认多标签中的目标位置；提醒仍保留未读',
          });
          return resolve({
            state: 'focused',
            message: target.tabId ? '已返回原窗口并验证原标签' :
              '已返回原窗口（未定位内部标签）',
          });
        }
        if (result.windowFocused === true && result.reason === 'tab_unavailable') return resolve({
          state: 'partial',
          message: '已返回原窗口，但原标签已变化或 UI Automation 不可用；提醒仍保留未读',
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
