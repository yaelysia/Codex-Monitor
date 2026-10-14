import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AlertStateStore, normalizeAlertState } from '../electron/alert-store';
import { AlertTracker } from '../src/shared/alert-tracker';
import type { SessionRecord, ScanResponse } from '../src/shared/types';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const ID = '019a21b0-aaaa-7ccc-8ddd-111122223333';
const dirs: string[] = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-alerts-')); dirs.push(d); return d; };
const session = (status: SessionRecord['status']): SessionRecord => ({
  id: ID, key: 'local:' + ID, sourceId: 'local', sourceLabel: 'Windows',
  workspace: 'C:\\PRIVATE_WORKSPACE', title: 'PRIVATE_PROMPT_TITLE',
  status, statusReason: 'PRIVATE_REASON', updatedAt: NOW,
  ageAtSourceMs: 0, startedAt: null,
  byteSize: status === 'working' ? 100 : 120,
  finishedToken: status === 'finished' ? '2026-10-12T12:00:00Z|turn-1' : null,
});
const snap = (record: SessionRecord, at: number): ScanResponse => ({
  scannedAt: at, sources: [{ id: 'local', label: 'Windows', kind: 'local',
    error: null, sessions: [record] }],
});
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, {recursive:true, force:true}); });

describe('persisted minimal notification inbox', () => {
  it('keeps unread/read alerts and muted setting without writing conversation data', () => {
    const root = dir();
    const tracker = new AlertTracker();
    tracker.observe(snap(session('working'), NOW), NOW);
    const finished = {...session('finished'), updatedAt: NOW + 12000,
      ageAtSourceMs: 0 };
    const items = tracker.observe(snap(finished, NOW + 12_000), NOW + 12_000);
    expect(items).toHaveLength(1);
    tracker.setMuted(true);
    const store = new AlertStateStore(root);
    store.update(tracker.snapshot(), NOW + 12_000);
    store.flush();
    const content = fs.readFileSync(path.join(root, 'alert-state.json'), 'utf8');
    expect(content).not.toMatch(/PRIVATE_PROMPT_TITLE|PRIVATE_WORKSPACE|PRIVATE_REASON|questionText/);
    const restored = new AlertTracker();
    restored.restore(new AlertStateStore(root).load(NOW + 13_000));
    expect(restored.getMuted()).toBe(true);
    expect(restored.getAlerts()[0]).toMatchObject({read:false, title:'已保存的任务提醒'});
    expect(restored.state(snap(finished, NOW + 13_000)).alerts[0]?.title).toBe('PRIVATE_PROMPT_TITLE');
    restored.acknowledge(items[0]!.id);
    store.update(restored.snapshot(), NOW + 13_000);
    store.flush();
    expect(new AlertStateStore(root).load(NOW + 14_000)?.alerts[0]?.read).toBe(true);
  });
  it('prevents repeating a previously seen turn after restart', () => {
    const tracker = new AlertTracker();
    tracker.observe(snap(session('working'), NOW), NOW);
    const completed = { ...session('finished'), updatedAt: NOW + 10_000, ageAtSourceMs: 100 };
    expect(tracker.observe(snap(completed, NOW + 12_000), NOW + 12_000)).toHaveLength(1);
    const fresh = new AlertTracker();
    fresh.restore(normalizeAlertState(tracker.snapshot(), NOW + 13_000));
    fresh.observe(snap(session('working'), NOW + 20_000), NOW + 20_000);
    expect(fresh.observe(snap({...completed, ageAtSourceMs:100}, NOW + 30_000),
      NOW + 30_000)).toHaveLength(0);
  });
  it('restores interruption alerts and dedupe IDs without saving conversation text', () => {
    const tracker = new AlertTracker();
    tracker.observe(snap(session('working'), NOW), NOW);
    const interrupted = {...session('interrupted'), updatedAt: NOW + 10_000,
      interruptedToken: 'abort|turn-a'};
    const emitted = tracker.observe(snap(interrupted, NOW + 12_000), NOW + 12_000);
    expect(emitted.map(alert => alert.kind)).toEqual(['interrupted']);
    const root = dir();
    const store = new AlertStateStore(root);
    store.update(tracker.snapshot(), NOW + 12_000);
    store.flush();
    const raw = fs.readFileSync(path.join(root, 'alert-state.json'), 'utf8');
    expect(raw).not.toMatch(/PRIVATE_PROMPT_TITLE|PRIVATE_WORKSPACE|PRIVATE_REASON/);
    const restored = new AlertTracker();
    restored.restore(new AlertStateStore(root).load(NOW + 13_000));
    expect(restored.getAlerts()[0]).toMatchObject({
      kind: 'interrupted', read: false, title: '已保存的任务提醒',
    });
    restored.acknowledge(emitted[0]!.id);
    expect(restored.getAlerts()[0]?.read).toBe(true);
    restored.observe(snap(session('working'), NOW + 20_000), NOW + 20_000);
    expect(restored.observe(snap(interrupted, NOW + 24_000), NOW + 24_000)).toEqual([]);
  });

  it('drops corrupted, extra-field and expired entries safely', () => {
    const root = dir();
    fs.writeFileSync(path.join(root, 'alert-state.json'), '{not json');
    expect(new AlertStateStore(root).load(NOW)).toBeNull();
    const validId = JSON.stringify(['local:'+ID,'waiting','token']);
    const safe = normalizeAlertState({version:1,muted:false,alerts:[
      {id:validId,sessionKey:'local:'+ID,sessionId:ID,kind:'waiting',
        at:NOW-31*24*3600_000,read:false,title:'PRIVATE'},
      {id:validId,sessionKey:'local:'+ID,sessionId:ID,kind:'waiting',
        at:NOW,read:true,questionText:'PRIVATE'},
    ],seenAlertIds:[validId,'bad']}, NOW);
    expect(safe?.alerts).toEqual([{id:validId,sessionKey:'local:'+ID,sessionId:ID,
      kind:'waiting',at:NOW,read:true}]);
    expect(JSON.stringify(safe)).not.toContain('PRIVATE');
  });
});
