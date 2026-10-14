import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopEvidenceStore } from '../electron/desktop-evidence-store';
import { DesktopLogEventCache, type DesktopLogEvent } from '../src/shared/desktop-log-status';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const ID = '019a21b0-aaaa-7ccc-8ddd-111122223333';
const TURN = '019a21b0-aaaa-7ccc-8ddd-999922223333';
const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-event-store-'));
  roots.push(dir); return dir; };
const event = (at: number, type: DesktopLogEvent['type'] = 'turn-start-accepted'): DesktopLogEvent => ({
  threadId: ID, at, type,
  ...(type === 'turn-displayed-complete' ? { turnId: TURN } : {}),
});

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Desktop metadata-only runtime event store', () => {
  it('rehydrates bounded turn lifecycle evidence without reading logs or user text', () => {
    const dir = root();
    const store = new DesktopEvidenceStore(dir);
    const cache = new DesktopLogEventCache();
    cache.observe(new Map([[ID, event(NOW - 3000)]]), NOW);
    store.update(cache.snapshot(NOW));
    store.flush();
    const file = path.join(dir, 'desktop-runtime-evidence.json');
    const json = fs.readFileSync(file, 'utf8');
    expect(json).toContain(ID);
    expect(json).not.toMatch(/PRIVATE|prompt|workspace|access_token|terminal_output/);
    expect(fs.readdirSync(dir)).toEqual(['desktop-runtime-evidence.json']);

    const restarted = new DesktopLogEventCache();
    restarted.restore(new DesktopEvidenceStore(dir).load(), NOW + 5000);
    expect(restarted.snapshot(NOW + 5000)).toEqual([event(NOW - 3000)]);
  });

  it('overwrites prior start when a later completion has been observed', () => {
    const dir = root(), store = new DesktopEvidenceStore(dir);
    const first = new DesktopLogEventCache();
    first.observe(new Map([[ID, event(NOW - 10_000)]]), NOW);
    store.update(first.snapshot(NOW));
    store.flush();
    first.observe(new Map([[ID, event(NOW - 2000, 'turn-displayed-complete')]]), NOW);
    store.update(first.snapshot(NOW));
    store.flush();
    const restarted = new DesktopLogEventCache();
    restarted.restore(new DesktopEvidenceStore(dir).load(), NOW + 1000);
    expect(restarted.snapshot(NOW + 1000)[0]).toEqual(
      event(NOW - 2000, 'turn-displayed-complete'));
  });

  it('ignores malformed, oversized and unsupported-version files without writing anything', () => {
    const dir = root();
    const file = path.join(dir, 'desktop-runtime-evidence.json');
    const store = new DesktopEvidenceStore(dir);
    expect(store.load()).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
    fs.writeFileSync(file, 'NOT JSON');
    expect(store.load()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ version: 7, events: [event(NOW)] }));
    expect(store.load()).toEqual([]);
    fs.writeFileSync(file, 'X'.repeat(65 * 1024));
    expect(store.load()).toEqual([]);
  });

  it('strips unknown/private record fields before persisting', () => {
    const dir = root();
    const store = new DesktopEvidenceStore(dir);
    store.update([{ ...event(NOW), privatePrompt: 'DO NOT STORE ME',
      sshKey: 'PRIVATE KEY' }] as unknown as DesktopLogEvent[]);
    store.flush();
    const result = fs.readFileSync(path.join(dir, 'desktop-runtime-evidence.json'), 'utf8');
    expect(result).not.toContain('DO NOT STORE');
    expect(result).not.toContain('PRIVATE KEY');
  });
});
