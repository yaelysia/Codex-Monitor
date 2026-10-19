import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { ScanResponse, SessionRecord } from '../src/shared/types';

const fake = vi.hoisted(() => ({
  spawn: vi.fn(), execFile: vi.fn(), openExternal: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\Codex-Monitor' },
  shell: { openExternal: fake.openExternal },
}));
vi.mock('node:child_process', () => ({
  spawn: fake.spawn,
  execFile: fake.execFile,
}));
vi.mock('../electron/desktop-window-guard', () => ({
  openDesktopUrlKeepingGeometry: vi.fn(async (url: string, _script: string,
    open: (url: string) => Promise<void>) => open(url)),
}));

import { AutoWindowTracker } from '../electron/window-tracking';

class NativeChild extends EventEmitter {
  stdout = new EventEmitter();
  kills = 0;
  kill(): boolean {
    this.kills++;
    this.emit('exit', 1);
    return true;
  }
}

const children: NativeChild[] = [];
const sample = (at: number) => JSON.stringify({
  type: 'foreground', at, hwnd: '0x1357', pid: 1357,
  startedAt: 1000, app: 'vscode',
}) + '\n';
const sessionKey = 'local:019a1020-0000-7000-8000-111122223333';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-12T08:00:00Z'));
  children.length = 0;
  fake.spawn.mockReset();
  fake.execFile.mockReset();
  fake.openExternal.mockReset();
  fake.openExternal.mockResolvedValue(undefined);
  fake.spawn.mockImplementation(() => {
    const child = new NativeChild();
    children.push(child);
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Windows foreground watcher recovery', () => {
  it('starts listening only after a valid foreground sample is received', () => {
    const tracker = new AutoWindowTracker('win32');
    try {
      tracker.start();
      expect(children).toHaveLength(1);
      expect(tracker.status(sessionKey).ready).toBe(false);
      children[0]!.stdout.emit('data', Buffer.from(sample(Date.now() - 1000)));
      expect(tracker.status(sessionKey).message).toContain('再次发送消息');
    } finally { tracker.stop(); }
  });

  it('automatically retries after native watch exits and does not restart after stop', async () => {
    const tracker = new AutoWindowTracker('win32');
    tracker.start();
    expect(children).toHaveLength(1);
    children[0]!.emit('exit', 1);
    expect(tracker.status(sessionKey).message).toContain('恢复');
    await vi.advanceTimersByTimeAsync(2000);
    expect(children).toHaveLength(2);
    tracker.stop();
    children[1]!.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(2);
  });

  it('restarts a native observer that never publishes valid foreground evidence', async () => {
    const tracker = new AutoWindowTracker('win32');
    try {
      tracker.start();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(children[0]?.kills).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(children).toHaveLength(2);
      children[1]!.stdout.emit('data', Buffer.from(sample(Date.now() - 1000)));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(children).toHaveLength(2);
      expect(children[1]?.kills).toBe(0);
    } finally { tracker.stop(); }
  });

  it('keeps a safely revalidated HWND binding when only the watcher stops', () => {
    const tracker = new AutoWindowTracker('win32');
    try {
      const at = Date.now();
      tracker.start();
      children[0]!.stdout.emit('data', Buffer.from(sample(at - 1000)));
      const scan: ScanResponse = {
        scannedAt: at, sources: [{
          id: 'local', label: 'Windows', kind: 'local', error: null,
          sessions: [{
            key: sessionKey, id: sessionKey.slice(6), sourceId: 'local',
            sourceLabel: 'Windows', workspace: null,
            title: null, status: 'working', statusReason: 'test',
            updatedAt: at, startedAt: null, clientKind: 'vscode',
            lastUserInputAgeAtSourceMs: 100,
          }],
        }],
      };
      tracker.observeScan(scan);
      expect(tracker.status(sessionKey).ready).toBe(true);
      children[0]!.emit('exit', 1);
      expect(tracker.status(sessionKey).ready).toBe(true);
    } finally { tracker.stop(); }
  });
});

describe('original-window persistent bindings across Monitor restarts', () => {
  it('reloads the binding without another user prompt, then revalidates before focus', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-window-binding-'));
    const now = Date.now();
    try {
      const tracker = new AutoWindowTracker('win32', storage);
      tracker.start();
      children[0]!.stdout.emit('data', Buffer.from(sample(now - 1000)));
      const scan: ScanResponse = { scannedAt: now, sources: [{
        id: 'local', kind: 'local', label: 'Windows', error: null, sessions: [{
          key: sessionKey, id: sessionKey.slice(6), sourceId: 'local',
          sourceLabel: 'Windows', workspace: null, title: null,
          status: 'working', statusReason: 'test', updatedAt: now,
          startedAt: null, clientKind: 'vscode', lastUserInputAgeAtSourceMs: 100,
          lastUserInputAtSourceMs: now - 100,
        }],
      }] };
      tracker.observeScan(scan);
      expect(tracker.status(sessionKey).ready).toBe(true);
      tracker.stop();
      const file = path.join(storage, 'window-bindings.json');
      expect(fs.existsSync(file)).toBe(true);
      const persisted = fs.readFileSync(file, 'utf8');
      expect(persisted).toContain(sessionKey);
      expect(persisted).not.toContain('statusReason');

      const reopened = new AutoWindowTracker('win32', storage);
      try {
        reopened.start();
        expect(reopened.status(sessionKey).ready).toBe(true);
        expect(reopened.status(sessionKey).message).toContain('上次窗口绑定');
        fake.execFile.mockImplementationOnce((_cmd, _args, _options, cb) =>
          cb(null, '{"ok":true,"tabFocused":false}\n', ''));
        const result = await reopened.focusOriginalWindow(sessionKey);
        expect(result.state).toBe('focused');
        const nativeArguments = fake.execFile.mock.calls.at(-1)?.[1] as string[];
        expect(nativeArguments).toContain('0x1357');
        expect(nativeArguments).toContain('1357');
        expect(nativeArguments).toContain('1000');
      } finally { reopened.stop(); }
    } finally { fs.rmSync(storage, { recursive: true, force: true }); }
  });

  it('does not activate or retain an OS window when native verification finds it stale', async () => {
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-binding-stale-'));
    const now = Date.now();
    try {
      const persisted = { version: 1, bindings: [{
        sessionKey, savedAt: now - 10_000, inputToken: now - 10_000,
        window: { at: now - 10_000, inputAt: now - 10_000,
          hwnd: '0xbeef', pid: 777, startedAt: now - 90_000, app: 'vscode' },
      }] };
      fs.writeFileSync(path.join(storage, 'window-bindings.json'), JSON.stringify(persisted));
      const tracker = new AutoWindowTracker('win32', storage);
      try {
        tracker.start();
        expect(tracker.status(sessionKey).ready).toBe(true);
        fake.execFile.mockImplementationOnce((_cmd, _args, _options, cb) =>
          cb(null, '{"ok":false,"reason":"process_changed"}\n', ''));
        const result = await tracker.focusOriginalWindow(sessionKey);
        expect(result.state).toBe('stale');
        expect(tracker.status(sessionKey).ready).toBe(false);
      } finally { tracker.stop(); }
      const next = JSON.parse(fs.readFileSync(path.join(storage, 'window-bindings.json'), 'utf8'));
      expect(next.bindings).toHaveLength(0);
    } finally { fs.rmSync(storage, { recursive: true, force: true }); }
  });
});

describe('Desktop official deep-link navigation', () => {
  const desktop = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: sessionKey.slice('local:'.length), key: sessionKey,
    sourceId: 'local', sourceLabel: 'Windows', workspace: null,
    title: 'Desktop task', status: 'working', statusReason: 'native',
    clientKind: 'desktop', updatedAt: Date.now(), startedAt: null,
    ...overrides,
  });

  it('opens the exact Desktop thread without waiting for an HWND binding', async () => {
    const tracker = new AutoWindowTracker('win32');
    expect(tracker.status(sessionKey).ready).toBe(false);
    expect(tracker.status(sessionKey, desktop())).toMatchObject({
      ready: true, host: 'desktop',
    });
    const result = await tracker.focusOriginalWindow(sessionKey, desktop());
    expect(result.state).toBe('opened');
    expect(fake.openExternal).toHaveBeenCalledExactlyOnceWith(
      'codex://threads/019a1020-0000-7000-8000-111122223333');
    expect(fake.execFile).not.toHaveBeenCalled();
  });

  it('handles a CLI-originated thread resumed in Desktop without hijacking a normal CLI task', async () => {
    const tracker = new AutoWindowTracker('win32');
    const cli = desktop({ clientKind: 'terminal' });
    expect(tracker.status(sessionKey, cli).ready).toBe(false);
    await tracker.focusOriginalWindow(sessionKey, { ...cli, desktopRuntimeObserved: true });
    expect(fake.openExternal).toHaveBeenCalledTimes(1);
    expect(tracker.status(sessionKey, { ...cli, desktopRuntimeObserved: true })).toMatchObject({
      ready: true, host: 'desktop',
    });
  });

  it('reports an unregistered Desktop protocol instead of guessing a window', async () => {
    const tracker = new AutoWindowTracker('win32');
    fake.openExternal.mockRejectedValueOnce(new Error('protocol not registered'));
    const result = await tracker.focusOriginalWindow(sessionKey, desktop());
    expect(result.state).toBe('unavailable');
    expect(result.message).toContain('codex://');
    expect(fake.execFile).not.toHaveBeenCalled();
  });

  it('falls back to a previously verified HWND if protocol invocation fails', async () => {
    const tracker = new AutoWindowTracker('win32');
    const at = Date.now();
    tracker.start();
    try {
      children.at(-1)!.stdout.emit('data', Buffer.from(JSON.stringify({
        type: 'foreground', at: at - 1000, hwnd: '0x1357', pid: 1357,
        startedAt: 1000, app: 'desktop',
      }) + '\n'));
      const s: ScanResponse = { scannedAt: at, sources: [{
        id: 'local', kind: 'local', label: 'Windows', error: null,
        sessions: [{ ...desktop(), lastUserInputAgeAtSourceMs: 200 }],
      }] };
      tracker.observeScan(s);
      expect(tracker.status(sessionKey).ready).toBe(true);
      fake.openExternal.mockRejectedValueOnce(new Error('protocol missing'));
      fake.execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
        cb(null, '{"ok":true,"tabFocused":false}\n', '');
      });
      expect((await tracker.focusOriginalWindow(sessionKey, desktop())).state).toBe('focused');
      expect(fake.execFile).toHaveBeenCalledTimes(1);
    } finally { tracker.stop(); }
  });
});

describe('native foreground toast suppression through live tracker', () => {
  it('does not suppress until a live bound foreground sample, nor during watcher downtime', () => {
    const tracker = new AutoWindowTracker('win32');
    const now = Date.now();
    try {
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(false);
      tracker.start();
      children.at(-1)!.stdout.emit('data', Buffer.from(sample(now - 1000)));
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(false);
      const snapshot: ScanResponse = {scannedAt:now,sources:[{
        id:'local',kind:'local',label:'Windows',error:null,
        capturedAt:now,captureStartedAt:now,
        sessions:[{
          key:sessionKey,id:sessionKey.slice(6),sourceId:'local',sourceLabel:'Windows',
          status:'working',statusReason:'working',title:null,workspace:null,
          updatedAt:now,startedAt:null,clientKind:'vscode',
          lastUserInputAgeAtSourceMs:100,lastUserInputAtSourceMs:now-100,
        }],
      }]};
      tracker.observeScan(snapshot);
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(true);
      children.at(-1)!.emit('exit', 1);
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(false);
    } finally { tracker.stop(); }
    expect(tracker.isSessionForeground(sessionKey, now)).toBe(false);
  });

  it('trusts a restored binding after new native identity verification, without requiring another prompt', () => {
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-foreground-binding-'));
    const now=Date.now();
    const record={
      version:1,bindings:[{
        sessionKey,savedAt:now-2000,inputToken:now-2000,
        window:{ at:now-2000,inputAt:now-2000,hwnd:'0x1357',pid:1357,
          startedAt:1000,app:'vscode' },
      }],
    };
    fs.writeFileSync(path.join(folder,'window-bindings.json'),JSON.stringify(record));
    const tracker=new AutoWindowTracker('win32',folder);
    try {
      tracker.start();
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(false);
      children.at(-1)!.stdout.emit('data',Buffer.from(sample(now-1000)));
      expect(tracker.status(sessionKey).ready).toBe(true);
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(true);
      const scan:ScanResponse={scannedAt:now,sources:[{
        id:'local',label:'Windows',kind:'local',error:null,
        capturedAt:now,captureStartedAt:now,
        sessions:[{
          key:sessionKey,id:sessionKey.slice(6),sourceId:'local',sourceLabel:'Windows',
          status:'working',statusReason:'live',title:null,workspace:null,
          updatedAt:now,startedAt:null,clientKind:'vscode',
          lastUserInputAgeAtSourceMs:100,lastUserInputAtSourceMs:now-100,
        }],
      }]};
      tracker.observeScan(scan);
      expect(tracker.isSessionForeground(sessionKey, now)).toBe(true);
    } finally { tracker.stop(); fs.rmSync(folder,{recursive:true,force:true}); }
  });

  it('does not suppress if native tracking is unavailable or disabled', () => {
    const unsupported=new AutoWindowTracker('linux');
    expect(unsupported.isSessionForeground(sessionKey)).toBe(false);
  });
});

describe('manual foreground switching triggers session read confirmation', () => {
  it('emits an observation when an already-bound Codex window becomes foreground, never on a wrong window', () => {
    const now=Date.now();
    let unread=true;
    const confirmed:string[]=[];
    let tracker:AutoWindowTracker;
    tracker=new AutoWindowTracker('win32',undefined,()=>{
      if (unread && tracker.isSessionForegroundForRead(sessionKey)) {
        unread=false;
        confirmed.push(sessionKey);
      }
    });
    try {
      tracker.start();
      const native=children.at(-1)!;
      native.stdout.emit('data',Buffer.from(sample(now-1000)));
      const scan:ScanResponse={scannedAt:now,sources:[{
        id:'local',kind:'local',label:'Windows',error:null,
        capturedAt:now,captureStartedAt:now,
        sessions:[{
          id:sessionKey.slice(6),key:sessionKey,sourceId:'local',sourceLabel:'Windows',
          title:'VS Code task',workspace:null,clientKind:'vscode',
          status:'finished',statusReason:'finished',updatedAt:now,
          ageAtSourceMs:100,startedAt:null,lastUserInputAgeAtSourceMs:100,
          lastUserInputAtSourceMs:now-100,
        }],
      }]};
      tracker.observeScan(scan);
      // Reading only starts after a notification exists. Existing foreground
      // evidence is not silently replayed; the next user window activation is.
      unread=true;
      confirmed.length=0;
      const other=JSON.stringify({
        type:'foreground',at:now+400,hwnd:'0x9999',pid:9999,
        startedAt:2000,app:'other',
      })+'\n';
      native.stdout.emit('data',Buffer.from(other));
      expect(confirmed).toEqual([]);
      vi.setSystemTime(now+900);
      native.stdout.emit('data',Buffer.from(sample(now+700)));
      expect(confirmed).toEqual([sessionKey]);
      native.stdout.emit('data',Buffer.from(sample(now+800)));
      expect(confirmed).toEqual([sessionKey]);
    } finally {tracker.stop();}
  });

  it('confirms a uniquely bound restored HWND only after live identity revalidation, not during downtime', () => {
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'codex-foreground-read-'));
    const now=Date.now();
    fs.writeFileSync(path.join(folder,'window-bindings.json'),JSON.stringify({
      version:1,bindings:[{
        sessionKey,savedAt:now-1000,inputToken:now-1000,
        window:{at:now-1000,inputAt:now-1000,
          hwnd:'0x1357',pid:1357,startedAt:1000,app:'vscode'},
      }],
    }));
    const confirmed:string[]=[];
    let tracker:AutoWindowTracker;
    tracker=new AutoWindowTracker('win32',folder,()=>{
      if(tracker.isSessionForegroundForRead(sessionKey)) confirmed.push(sessionKey);
    });
    try {
      tracker.start();
      const native=children.at(-1)!;
      expect(tracker.isSessionForegroundForRead(sessionKey,now)).toBe(false);
      expect(confirmed).toEqual([]);
      native.stdout.emit('data',Buffer.from(sample(now-500)));
      expect(tracker.status(sessionKey).ready).toBe(true);
      expect(confirmed).toEqual([sessionKey]);
      native.emit('exit',1);
      expect(tracker.isSessionForegroundForRead(sessionKey)).toBe(false);
    } finally {
      tracker.stop();
      fs.rmSync(folder,{recursive:true,force:true});
    }
  });
});

describe('real native observation wrapper in multi-conversation VS Code', () => {
  it('notifies only background threads after the most recent VS Code prompt is bound', () => {
    const tracker=new AutoWindowTracker('win32');
    const now=Date.now();
    try {
      tracker.start();
      const native=children.at(-1)!;
      native.stdout.emit('data',Buffer.from(sample(now-1000)));
      const sessionAt=(key:string,at:number):ScanResponse=>({
        scannedAt:at,sources:[{
          id:'local',kind:'local',label:'Windows',error:null,
          captureStartedAt:at,capturedAt:at,
          sessions:[{
            key,id:key.slice(6),sourceId:'local',sourceLabel:'Windows',
            status:'working',statusReason:'working',title:null,workspace:null,
            updatedAt:at,startedAt:null,clientKind:'vscode',
            lastUserInputAgeAtSourceMs:100,lastUserInputAtSourceMs:at-100,
          }],
        }],
      });
      tracker.observeScan(sessionAt('local:chat-a',now));
      vi.setSystemTime(now+10_000);
      native.stdout.emit('data',Buffer.from(sample(now+9_000)));
      tracker.observeScan(sessionAt('local:chat-b',now+10_000));
      expect(tracker.isSessionForeground('local:chat-b',now+10_100)).toBe(true);
      expect(tracker.isSessionForeground('local:chat-a',now+10_100)).toBe(false);
      expect(tracker.isSessionForegroundForRead('local:chat-b',now+10_100)).toBe(false);
    } finally { tracker.stop(); }
  });
});

describe('privacy-safe explanation of native toast suppression eligibility',()=>{
  it('shows the recent suppression reason next to original window status',()=>{
    const now=Date.now();
    const tracker=new AutoWindowTracker('win32');
    try {
      tracker.start();
      children.at(-1)!.stdout.emit('data',Buffer.from(sample(now-1000)));
      const snapshot:ScanResponse={scannedAt:now,sources:[{
        id:'local',label:'Windows',kind:'local',error:null,
        capturedAt:now,captureStartedAt:now,
        sessions:[{
          key:sessionKey,id:sessionKey.slice(6),sourceId:'local',sourceLabel:'Windows',
          title:'PRIVATE_SESSION_TITLE',status:'finished',statusReason:'private reason',
          clientKind:'vscode',workspace:null,updatedAt:now,startedAt:null,
          lastUserInputAgeAtSourceMs:100,lastUserInputAtSourceMs:now-100,
        }],
      }]};
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
      expect(tracker.status(sessionKey).message).toContain('未找到该会话的原窗口绑定');
      tracker.observeScan(snapshot);
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(true);
      const message=tracker.status(sessionKey).message;
      expect(message).toContain('最近一次系统通知判定：');
      expect(message).toContain('系统弹窗被抑制');
      expect(message).not.toContain('PRIVATE_SESSION_TITLE');
      expect(message).not.toContain(sessionKey);
      vi.setSystemTime(now+16*60_000);
      expect(tracker.status(sessionKey).message).not.toContain('最近一次系统通知判定');
    } finally {tracker.stop();}
  });

  it('records watcher failure without inventing foreground data',()=>{
    const tracker=new AutoWindowTracker('win32');
    const now=Date.now();
    expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
    expect(tracker.status(sessionKey).message).toContain('Windows 原窗口监听正在恢复');
    expect(tracker.status(sessionKey).message).toContain('Windows 原生前台监听未就绪');
  });
});

describe('restored session foreground identity revalidation without a new Codex prompt', () => {
  function savedBinding(sessionKey: string, now: number, inputAt = now - 300_000) {
    return {
      sessionKey, savedAt: inputAt, inputToken: inputAt,
      window: {
        at: inputAt, inputAt, hwnd: '0x1357', pid: 1357,
        startedAt: 1000, app: 'vscode',
      },
    };
  }

  it('activates popup suppression and exact-session auto-read after a fresh matching foreground HWND', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'monitor-restored-foreground-'));
    const now = Date.now();
    fs.writeFileSync(path.join(root,'window-bindings.json'),JSON.stringify({
      version:1, bindings:[savedBinding(sessionKey, now)],
    }));
    const reads:string[] = [];
    let tracker: AutoWindowTracker;
    tracker = new AutoWindowTracker('win32', root, () => {
      if (tracker.isSessionForegroundForRead(sessionKey)) reads.push(sessionKey);
    });
    try {
      tracker.start();
      expect(tracker.status(sessionKey).message).toContain('上次窗口绑定');
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
      expect(reads).toEqual([]);
      const win = children.at(-1)!;
      win.stdout.emit('data',Buffer.from(sample(now - 200)));
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(true);
      expect(tracker.isSessionForegroundForRead(sessionKey,now)).toBe(true);
      expect(reads).toEqual([sessionKey]);
      expect(tracker.status(sessionKey).message).not.toContain('尚待实时窗口身份核验');
      win.stdout.emit('data',Buffer.from(sample(now - 100)));
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(true);
    } finally { tracker.stop(); fs.rmSync(root,{recursive:true,force:true}); }
  });

  it('rejects a restored association when a native sample is old or PID/process instance changed', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-restored-stale-'));
    const now=Date.now();
    fs.writeFileSync(path.join(root,'window-bindings.json'),JSON.stringify({
      version:1,bindings:[savedBinding(sessionKey,now)],
    }));
    const tracker=new AutoWindowTracker('win32',root);
    try {
      tracker.start();
      const child=children.at(-1)!;
      child.stdout.emit('data',Buffer.from(sample(now - 20_000)));
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
      expect(tracker.status(sessionKey).message).toContain('上次窗口绑定');
      child.stdout.emit('data',Buffer.from(JSON.stringify({
        type:'foreground',at:now-400,hwnd:'0x1357',pid:1357,
        startedAt:2000,app:'vscode',
      })+'\n'));
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
      expect(tracker.status(sessionKey).message).toContain('上次窗口绑定');
      child.stdout.emit('data',Buffer.from(sample(now-200)));
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(true);
      child.emit('exit',1);
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
      expect(tracker.isSessionForegroundForRead(sessionKey,now)).toBe(false);
    } finally { tracker.stop(); fs.rmSync(root,{recursive:true,force:true}); }
  });

  it('restores multiple VS Code chats but auto-reads neither ambiguous conversation', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-restored-ambiguous-'));
    const now=Date.now();
    const another='local:019a1020-0000-7000-8000-777788889999';
    fs.writeFileSync(path.join(root,'window-bindings.json'),JSON.stringify({
      version:1,bindings:[savedBinding(sessionKey,now,now-20_000),
        savedBinding(another,now,now-5000)],
    }));
    const reads:string[]=[];
    let tracker:AutoWindowTracker;
    tracker=new AutoWindowTracker('win32',root,()=>{
      for(const key of [sessionKey,another])
        if(tracker.isSessionForegroundForRead(key)) reads.push(key);
    });
    try {
      tracker.start();
      children.at(-1)!.stdout.emit('data',Buffer.from(sample(now-200)));
      expect(reads).toEqual([]);
      expect(tracker.isSessionForeground(sessionKey,now)).toBe(false);
      expect(tracker.isSessionForeground(another,now)).toBe(true);
      expect(tracker.isSessionForegroundForRead(another,now)).toBe(false);
    } finally {tracker.stop(); fs.rmSync(root,{recursive:true,force:true});}
  });
});

describe('actionable native foreground association diagnostics',()=>{
  it('reports why a VS Code session is unbound after a successful scan',()=>{
    const now=Date.now();
    const tracker=new AutoWindowTracker('win32');
    try {
      tracker.start();
      children.at(-1)!.stdout.emit('data',Buffer.from(sample(now-1000)));
      const row:SessionRecord={
        key:sessionKey,id:sessionKey.slice(6),sourceId:'local',
        sourceLabel:'Windows',title:'PRIVATE_USER_TEXT',workspace:null,
        clientKind:'vscode',status:'unknown',statusReason:'PRIVATE_ERROR',
        updatedAt:now,startedAt:null,lastUserInputAgeAtSourceMs:null,
      };
      tracker.observeScan({scannedAt:now,sources:[{
        id:'local',label:'Windows',kind:'local',
        capturedAt:now,captureStartedAt:now,error:null,sessions:[row],
      }]});
      const detail=tracker.status(sessionKey).message;
      expect(detail).toContain('最近会话关联检查');
      expect(detail).toContain('尚未找到有时间标记的用户提交记录');
      expect(detail).not.toContain(row.title);
      expect(detail).not.toContain(row.statusReason);
      expect(detail).not.toContain(sessionKey);
    } finally { tracker.stop(); }
  });
});
