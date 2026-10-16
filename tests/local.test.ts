import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localScanCacheStats, scanLocal } from '../electron/local';
import { LocalScanCache } from '../src/shared/local-scan-cache';
import type { SessionRecord } from '../src/shared/types';

const created: string[] = [];
afterEach(async () => { await Promise.all(created.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe('local scanner', () => {
  it('reads bounded metadata from dated Codex rollout directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-test-'));
    created.push(root);
    const directory = path.join(root, 'sessions', '2026', '10', '10');
    await fs.mkdir(directory, { recursive: true });
    const id = '01234567-89ab-4cde-8123-123456789abc';
    await fs.writeFile(path.join(directory, `rollout-${id}.jsonl`), [
      JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/dev/app' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ].join('\n'));
    const rows = await scanLocal(root, 'local', 'Windows');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, workspace: '/dev/app', status: 'finished', sourceLabel: 'Windows',
      rolloutPath: `2026/10/10/rollout-${id}.jsonl` });
  });
  it('rejects a missing sessions directory explicitly', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-test-'));
    created.push(root);
    await expect(scanLocal(root)).rejects.toThrow();
  });
  it('recovers lifecycle events for a fresh rollout longer than the short tail', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-long-'));
    created.push(root);
    const directory = path.join(root, 'sessions', '2026', '10', '10');
    await fs.mkdir(directory, { recursive: true });
    const id = '01234567-89ab-4cde-8123-123456789abc';
    const file = path.join(directory, `rollout-${id}.jsonl`);
    const rows = [
      { type: 'session_meta', payload: { id, cwd: '/tmp/active' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'reasoning', text: 'x'.repeat(250_000) } },
    ];
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const records = await scanLocal(root);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'working', byteSize: (await fs.stat(file)).size });
    await fs.utimes(file, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    expect((await scanLocal(root))[0]?.status).toBe('unknown');
  });
});


describe('bounded and safe local file cache', () => {
  const base: SessionRecord = {
    key: 'local:one', id: 'one', sourceId: 'local', sourceLabel: 'Windows',
    title: 'task', workspace: '/repo', status: 'working',
    statusReason: 'recent', updatedAt: 1_000_000, byteSize: 200, startedAt: null,
  };
  it('expires cached working/waiting states but retains terminal evidence', () => {
    const cache = new LocalScanCache();
    cache.put('/one', 1_000_000, 200, base);
    expect(cache.get('/one', 1_000_000, 200, 1_010_000)?.status).toBe('working');
    expect(cache.get('/one', 1_000_000, 200, 1_100_000)?.status).toBe('unknown');
    expect(cache.get('/one', 1_000_000, 201, 1_010_000)).toBeNull();
    cache.put('/two', 1_000_000, 100, { ...base, status: 'finished', finishedToken: 'turn-1' });
    expect(cache.get('/two', 1_000_000, 100, 2_000_000)?.status).toBe('finished');
    cache.put('/wait', 1_000_000, 100, { ...base, status: 'waiting' });
    expect(cache.get('/wait', 1_000_000, 100, 1_610_000)?.status).toBe('unknown');
    cache.retain(new Set(['/two']));
    expect(cache.stats().entries).toBe(1);
  });

  it('reuses unchanged rollout metadata and invalidates when new JSONL is written', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-cache-'));
    created.push(folder);
    const directory = path.join(folder, 'sessions', '2026', '10', '12');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, 'rollout-cache.jsonl');
    await fs.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'cache', cwd: '/repo' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
    ].join('\n'));
    const baseline = localScanCacheStats();
    expect((await scanLocal(folder))[0]?.status).toBe('working');
    const first = localScanCacheStats();
    expect(first.misses).toBeGreaterThan(baseline.misses);
    expect((await scanLocal(folder))[0]?.status).toBe('working');
    expect(localScanCacheStats().hits).toBeGreaterThan(first.hits);
    await fs.appendFile(file, '\n' +
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-one' } }));
    expect((await scanLocal(folder))[0]?.status).toBe('finished');
    expect(localScanCacheStats().misses).toBeGreaterThan(first.misses);
  });
});


describe('local cache keeps answered-question state fresh', () => {
  it('holds explicit unmatched question evidence within the configured freshness window', () => {
    const c = new LocalScanCache();
    const row: SessionRecord = {
      key: 'local:ask', id: 'ask', sourceId: 'local', sourceLabel: 'Windows',
      workspace: '/repo', title: 'ask', status: 'waiting', statusReason: 'tool request',
      waitingToken: 'blocking:q1', pendingQuestionToken: 'blocking:q1',
      updatedAt: 1_000_000, byteSize: 100, startedAt: null,
    };
    c.put('/ask', 1_000_000, 100, row);
    expect(c.get('/ask', 1_000_000, 100, 1_000_000 + 11 * 60_000)?.status).toBe('waiting');
    const stale = c.get('/ask', 1_000_000, 100, 1_000_000 + 7 * 60 * 60_000);
    expect(stale?.status).toBe('unknown');
    expect(stale?.pendingQuestionToken).toBeNull();
  });
});

// A pinned older rollout must be read from the exact file path, even when
// the newest 200 have crowded it out of the normal session index.
describe('bounded pinned local rollover sessions', () => {
  it('retains an older known-active session and detects its completion beyond newest 200', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-monitor-pinned-'));
    created.push(root);
    const dir = path.join(root, 'sessions', '2026', '10', '10');
    await fs.mkdir(dir, {recursive:true});
    const id = '01234567-89ab-4cde-8123-123456789abc';
    const relative = `2026/10/10/rollout-${id}.jsonl`;
    const old = path.join(dir, `rollout-${id}.jsonl`);
    await fs.writeFile(old, [
      JSON.stringify({type:'session_meta',payload:{id,cwd:'/project'}}),
      JSON.stringify({type:'event_msg',payload:{type:'task_started'}}),
    ].join('\n')+'\n');
    const earlier = new Date(Date.now()-3600_000);
    await fs.utimes(old, earlier, earlier);
    for(let i=0;i<210;i++) await fs.writeFile(path.join(dir,
      `rollout-fresh-${String(i).padStart(3,'0')}.jsonl`),
      JSON.stringify({type:'session_meta',payload:{id:'new-'+i}})+'\n');
    expect((await scanLocal(root)).some(s=>s.id===id)).toBe(false);
    expect((await scanLocal(root,'local','Windows',Date.now(),[relative]))
      .some(s=>s.id===id)).toBe(true);
    await fs.appendFile(old, JSON.stringify({
      type:'event_msg',timestamp:new Date().toISOString(),
      payload:{type:'task_complete',turn_id:'turn-1'},
    })+'\n');
    const updated = await scanLocal(root,'local','Windows',Date.now(),[relative]);
    expect(updated.find(s=>s.id===id)?.status).toBe('finished');
    expect(updated.length).toBeLessThanOrEqual(216);
  });
  it('ignores escaping pinned paths', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'codex-monitor-invalid-pin-'));
    created.push(root);
    await fs.mkdir(path.join(root,'sessions'),{recursive:true});
    const rows = await scanLocal(root,'local','Windows',Date.now(),
      ['../../outside.jsonl','C:/Windows/foo.jsonl','2026/10/10/../outside.jsonl']);
    expect(rows).toEqual([]);
  });
});

describe('local index integration with JSONL and the parsing cache', () => {
  it('reuses indexed stats on healthy watchers, updates changed files, and falls back to full scanning', async () => {
    const { noteLocalRolloutChange } = await import('../electron/local-file-index');
    const { localScanDiagnostics } = await import('../electron/local');
    const root = await fs.mkdtemp(path.join(os.tmpdir(),'monitor-incremental-'));
    created.push(root);
    const relative = '2026/10/15/rollout-local-index.jsonl';
    const directory = path.join(root, 'sessions','2026','10','15');
    await fs.mkdir(directory,{recursive:true});
    const file = path.join(directory,'rollout-local-index.jsonl');
    await fs.writeFile(file, JSON.stringify({
      type:'event_msg',payload:{type:'task_started'},
    })+'\n');
    expect((await scanLocal(root,'local','Windows',Date.now(),[],true))[0]?.status)
      .toBe('working');
    const first = localScanDiagnostics(root)!;
    expect(first.index.mode).toBe('full');
    expect(first.index.statCalls).toBe(1);
    const hits = localScanCacheStats().hits;
    await scanLocal(root,'local','Windows',Date.now()+1000,[],true);
    const cached = localScanDiagnostics(root)!;
    expect(cached.index.mode).toBe('incremental');
    expect(cached.index.statCalls).toBe(0);
    expect(localScanCacheStats().hits).toBeGreaterThan(hits);

    await fs.appendFile(file, JSON.stringify({
      type:'event_msg',timestamp:new Date().toISOString(),
      payload:{type:'task_complete',turn_id:'turn-index'},
    })+'\n');
    noteLocalRolloutChange(root,relative);
    expect((await scanLocal(root,'local','Windows',Date.now()+2000,[],true))[0]?.status)
      .toBe('finished');
    expect(localScanDiagnostics(root)!.index.statCalls).toBe(1);
    expect(localScanDiagnostics(root)!.cacheMisses).toBe(1);
    // Watcher unavailable: force a complete discovery and stat pass.
    await scanLocal(root,'local','Windows',Date.now()+3000,[],false);
    expect(localScanDiagnostics(root)!.index.mode).toBe('full');
  });
});

describe('VS Code question in an extended recent rollout tail', () => {
  it('recovers an async question buried behind 192 KiB of later activity without scanning the whole history', async () => {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-vscode-question-'));
    created.push(root);
    const day=path.join(root,'sessions','2026','10','16');
    await fs.mkdir(day,{recursive:true});
    const file=path.join(day,'rollout-vscode-question.jsonl');
    const event=(type:string,payload:Record<string,unknown>)=>JSON.stringify({type,payload})+'\n';
    const now=Date.now();
    const head=event('session_meta',{id:'019aaaab-bbbb-7ccc-8ddd-111122223333',
      originator:'codex_vscode',cwd:'/project'});
    const ask=event('response_item',{type:'agent_message',id:'ask-1',
      delivery:'async',questions:[{question:'需要哪个版本？'}]});
    const filler=Array.from({length:185},(_,i)=>
      event('response_item',{type:'reasoning', summary:[String(i),'x'.repeat(1400)]})).join('');
    const last=event('event_msg',{type:'turn_started',turn_id:'after-ask'});
    await fs.writeFile(file,head+ask+filler+last);
    await fs.utimes(file,new Date(now),new Date(now));
    const result=await scanLocal(root,'local','Windows',now);
    expect(result).toHaveLength(1);
    expect(result[0]?.clientKind).toBe('vscode');
    expect(result[0]?.status).toBe('working');
    expect(result[0]?.pendingQuestionToken).toBe('async:ask-1');
    expect(result[0]?.questionText).toBe('需要哪个版本？');
  });
});
