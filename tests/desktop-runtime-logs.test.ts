import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDesktopLogEvent, newestDesktopEvents, applyDesktopLogEvidence,
  DesktopLogEventCache } from
  '../src/shared/desktop-log-status';
import { findDesktopLogRoots, readDesktopLogSignals, inspectDesktopLogSignals } from '../electron/desktop-runtime-logs';
import { DesktopLogFollower } from '../scripts/desktop-log-follower.mjs';
import { DesktopDirectoryCache } from '../scripts/desktop-log-discovery.mjs';
import type { SessionRecord } from '../src/shared/types';

const NOW = Date.parse('2026-10-12T10:00:00Z');
const SESSION = '019a21b0-aaaa-7ccc-8ddd-111122223333';
const OTHER = '019a21b0-bbbb-7ccc-8ddd-111122223333';
const TURN = '019a21b0-aaaa-7ccc-8ddd-888899990000';
const time = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const accepted = (at: number, id = SESSION) =>
  time(at) + ' info [AppServerConnection] response_routed broadcastFallback=false ' +
    'conversationId=' + id + ' durationMs=10 errorCode=null ' +
    'method=turn/start originWebcontentsId=1 requestId=PRIVATE_REQUEST_ID';
const completed = (at: number, id = SESSION) =>
  time(at) + ' info [electron-message-handler] [desktop-notifications] ' +
    'show turn-complete conversationId=' + id + ' turnId=' + TURN +
    ' rendererWindowAppearance=primary';
const roots: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-log-reader-')); roots.push(dir); return dir; };
const write = (root: string, lines: string[], opts?: { msix?: boolean; when?: number }) => {
  const at = opts?.when ?? NOW;
  const date = new Date(at);
  const parent = opts?.msix ? path.join(root, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0',
    'LocalCache', 'Local', 'Codex', 'Logs') : path.join(root, 'Codex', 'Logs');
  const folder = path.join(parent, String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'codex-desktop-session-1357-t0-i1-101010-0.log');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  // Tests use an intentionally fixed clock (NOW). Match filesystem mtime to
  // that clock instead of inheriting CI wall time, which drifts during a run.
  fs.utimesSync(file, new Date(at), new Date(at));
  return file;
};
const row = (status: SessionRecord['status'], id = SESSION): SessionRecord => ({
  id, key: 'local:' + id, sourceId: 'local', sourceLabel: 'Windows',
  clientKind: 'desktop', title: null, workspace: null, status, statusReason: 'rollout',
  updatedAt: NOW, startedAt: null,
});
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('strict Windows Desktop lifecycle evidence', () => {
  it('accepts only same-session successful GUI-owned turn/start, not arbitrary text', () => {
    const event = parseDesktopLogEvent(accepted(-5), NOW);
    expect(event).toEqual({ threadId: SESSION, at: NOW - 5000, type: 'turn-start-accepted' });
    expect(parseDesktopLogEvent(accepted(-5).replace('errorCode=null','errorCode=-32600'), NOW)).toBeNull();
    expect(parseDesktopLogEvent(accepted(-5).replace('method=turn/start','method=thread/read'), NOW)).toBeNull();
    expect(parseDesktopLogEvent(time(-5) + ' info [other] ' + accepted(-5), NOW)).toBeNull();
    expect(parseDesktopLogEvent(time(-5) + ' error [electron-message-handler] ' +
      'Received turn/started for unknown conversation conversationId=' + SESSION, NOW)).toBeNull();
    expect(parseDesktopLogEvent(accepted(-30 * 3600), NOW)?.type).toBe('turn-start-accepted');
    expect(parseDesktopLogEvent(accepted(-73 * 3600), NOW)).toBeNull();
    expect(parseDesktopLogEvent(accepted(30), NOW)).toBeNull();
  });

  it('recognizes user-visible completion but ignores unknown-conversation completion errors', () => {
    expect(parseDesktopLogEvent(completed(-1), NOW)).toEqual({
      threadId: SESSION, at: NOW - 1000, turnId: TURN, type: 'turn-displayed-complete',
    });
    expect(parseDesktopLogEvent(time(-1) + ' error [electron-message-handler] ' +
      'Received turn/completed for unknown conversation conversationId=' + SESSION, NOW))
      .toBeNull();
    expect(newestDesktopEvents([
      parseDesktopLogEvent(accepted(-10), NOW)!,
      parseDesktopLogEvent(completed(-5), NOW)!,
      parseDesktopLogEvent(accepted(-1, OTHER), NOW)!,
    ]).get(SESSION)?.type).toBe('turn-displayed-complete');
  });

  it('never treats accepted turn/start as proof of permanent activity or ignores persisted completion', () => {
    const event = newestDesktopEvents([parseDesktopLogEvent(accepted(-20), NOW)!]);
    const active = row('unknown');
    const priorFinished = row('finished');
    priorFinished.finishedToken = time(-90) + '|' + TURN;
    const newerFinished = row('finished');
    newerFinished.finishedToken = time(-10) + '|' + TURN;
    const waiting = row('waiting');
    const other = row('unknown', OTHER);
    const notDesktop = row('unknown', '019a21b0-cccc-7ccc-8ddd-111122223333');
    notDesktop.clientKind = 'vscode';
    applyDesktopLogEvidence([active, priorFinished, newerFinished, waiting, other, notDesktop],
      event, NOW);
    expect(active).toMatchObject({ status: 'working', finishedToken: null });
    expect(active.statusReason).toContain('Desktop 自身日志');
    expect(priorFinished.status).toBe('working');
    expect(newerFinished.status).toBe('finished');
    expect(waiting.status).toBe('waiting');
    expect(other.status).toBe('unknown');
    expect(notDesktop.status).toBe('unknown');
    const completedEvent = newestDesktopEvents([
      parseDesktopLogEvent(accepted(-40), NOW)!,
      parseDesktopLogEvent(completed(-5), NOW)!,
    ]);
    const stable = row('unknown');
    applyDesktopLogEvidence([stable], completedEvent, NOW);
    expect(stable.status).toBe('unknown');
    const longTurn = row('unknown');
    applyDesktopLogEvidence([longTurn], event, NOW + 50 * 60_000);
    expect(longTurn.status).toBe('working');
    expect(longTurn.statusReason).toContain('未实时确认');
    const stale = row('unknown');
    applyDesktopLogEvidence([stale], event, NOW + 73 * 60 * 60_000);
    expect(stale.status).toBe('unknown');
  });
});

describe('Desktop log discovery including Windows MSIX virtualized LocalCache', () => {
  it('does not touch missing directories, and returns no made-up runtime evidence', async () => {
    const root = temp();
    expect(await readDesktopLogSignals(NOW, root)).toEqual(new Map());
    expect(fs.readdirSync(root)).toHaveLength(0);
    expect(await inspectDesktopLogSignals(NOW, root)).toMatchObject({
      logFilesRead: 0, signalCount: 0,
      discovery: { validLocalAppData: true, existingRootCount: 0,
        recentCandidateCount: 0 },
    });
  });

  it('recovers a 20-hour uncompleted GUI start on first Monitor scan', async () => {
    const root = temp();
    write(root, [accepted(-20 * 3600)]);
    // Cold boot reads the historical first-party event without any in-memory
    // cache or file growth while the monitor was stopped.
    const events = await readDesktopLogSignals(NOW, root);
    const start = events.get(SESSION);
    expect(start).toMatchObject({ type: 'turn-start-accepted',
      at: NOW - 20 * 60 * 60_000 });
    const longTurn = row('unknown');
    longTurn.updatedAt = NOW - 20 * 60 * 60_000;
    applyDesktopLogEvidence([longTurn], events, NOW);
    expect(longTurn.status).toBe('working');
    expect(longTurn.statusReason).toContain('未实时确认');
  });

  it('reads the actual local Desktop app log instead of a separate app server', async () => {
    const root = temp();
    write(root, [accepted(-30), completed(-10), accepted(-5, OTHER)]);
    const map = await readDesktopLogSignals(NOW, root);
    expect(map.get(SESSION)?.type).toBe('turn-displayed-complete');
    expect(map.get(OTHER)?.type).toBe('turn-start-accepted');
    expect(JSON.stringify([...map.values()])).not.toMatch(/PRIVATE_REQUEST_ID|requestId/);
    const details = await inspectDesktopLogSignals(NOW, root);
    expect(details.logFilesRead).toBe(1);
    expect(details.signalCount).toBe(3);
  });

  it('finds MSIX virtualized Codex/Logs and ignores unrelated package paths', async () => {
    const root = temp();
    write(root, [accepted(-6)], { msix: true });
    const found = await findDesktopLogRoots(root);
    expect(found.some(p => p.includes('LocalCache'))).toBe(true);
    const map = await readDesktopLogSignals(NOW, root);
    expect(map.get(SESSION)?.type).toBe('turn-start-accepted');
  });

  it('ignores log injections, unknown conversation, and oversized old files', async () => {
    const root = temp();
    const injected = time(-12) + ' info [text] USER SAID: ' + accepted(-12);
    write(root, [
      injected,
      time(-11) + ' error [electron-message-handler] Received turn/started for unknown conversation conversationId=' + SESSION,
      accepted(-10).replace('errorCode=null','errorCode=invalid'),
      completed(-4, OTHER),
    ]);
    const map = await readDesktopLogSignals(NOW, root);
    expect(map.has(SESSION)).toBe(false);
    expect(map.get(OTHER)?.type).toBe('turn-displayed-complete');
  });

  it('recovers complete recent lines at the end of a large rotated log', async () => {
    const root = temp();
    const file = write(root, [time(-3) + ' info [unrelated] ' + 'PRIVATE'.repeat(70000),
      accepted(-2)]);
    expect(fs.statSync(file).size).toBeGreaterThan(320 * 1024);
    const map = await readDesktopLogSignals(NOW, root);
    expect(map.get(SESSION)?.type).toBe('turn-start-accepted');
  });
});

describe('all native completion signals in a fast resumed turn', () => {
  it('keeps completion even when a newer same-thread start supersedes it', async () => {
    const root = temp();
    write(root, [accepted(-10), completed(-4), accepted(-1)]);
    const signal = await inspectDesktopLogSignals(NOW, root,
      new DesktopLogFollower(), new DesktopDirectoryCache());
    expect(signal.events.get(SESSION)?.type).toBe('turn-start-accepted');
    expect(signal.completions?.map(x => x.type))
      .toEqual(['turn-displayed-complete']);
    expect(signal.completions?.[0]?.turnId).toBe(TURN);
  });
});

describe('incremental Desktop log follow under heavy output', () => {
  it('captures a start overwritten in the moving tail by 650 KiB of later messages', async () => {
    const root = temp();
    const file = write(root, [time(-10) + ' info [noise] initial']);
    const initial = await inspectDesktopLogSignals(NOW, root);
    expect(initial.events.has(SESSION)).toBe(false);
    fs.appendFileSync(file, accepted(1) + '\n' +
      time(2) + ' info [noise] ' + 'x'.repeat(650_000) + '\n');
    fs.utimesSync(file, new Date(NOW + 3000), new Date(NOW + 3000));
    const subsequent = await inspectDesktopLogSignals(NOW + 4000, root);
    expect(subsequent.events.get(SESSION)?.type).toBe('turn-start-accepted');
    expect(subsequent.signalCount).toBe(1);
    // Reading later unchanged data does not fabricate new lifecycle events.
    const unchanged = await inspectDesktopLogSignals(NOW + 5000, root);
    expect(unchanged.events.has(SESSION)).toBe(false);
  });

  it('examines more than twelve simultaneous Desktop log files', async () => {
    const root = temp();
    const path0 = write(root, [accepted(-5)]);
    const folder = path.dirname(path0);
    for (let i = 0; i < 19; i++) {
      const file = path.join(folder, 'codex-desktop-extra-' + i + '.log');
      fs.writeFileSync(file, time(-3) + ' info [noise] heartbeat\n');
      fs.utimesSync(file, new Date(NOW + i + 100), new Date(NOW + i + 100));
    }
    const summary = await inspectDesktopLogSignals(NOW + 1000, root);
    expect(summary.discovery.recentCandidateCount).toBe(20);
    expect(summary.logFilesRead).toBeGreaterThanOrEqual(20);
    expect(summary.events.get(SESSION)?.type).toBe('turn-start-accepted');
  });
});

describe('bounded runtime I/O metrics', () => {
  it('skips unchanged files and caches directory enumerations without missing appends', async () => {
    const root = temp();
    const file = write(root, [accepted(-10)]);
    const follower = new DesktopLogFollower();
    const catalog = new DesktopDirectoryCache();
    const first = await inspectDesktopLogSignals(NOW, root, follower, catalog);
    expect(first.metrics?.logBytesRead).toBeGreaterThan(0);
    expect(first.metrics?.directoriesEnumerated).toBeGreaterThan(0);
    const unchanged = await inspectDesktopLogSignals(NOW + 1000, root, follower, catalog);
    expect(unchanged.metrics?.logBytesRead).toBe(0);
    expect(unchanged.metrics?.unchangedFiles).toBeGreaterThanOrEqual(1);
    expect(unchanged.metrics?.directoryCacheHits).toBeGreaterThan(0);
    fs.appendFileSync(file, accepted(2, OTHER) + '\n');
    fs.utimesSync(file, new Date(NOW + 2500), new Date(NOW + 2500));
    const next = await inspectDesktopLogSignals(NOW + 3000, root, follower, catalog);
    expect(next.events.get(OTHER)?.type).toBe('turn-start-accepted');
    expect(next.metrics?.logBytesRead).toBeGreaterThan(0);
    expect(next.metrics?.backlogFiles).toBe(0);
  });
});

describe('streaming follower with strict memory bounds', () => {
  it('reads multi-megabyte input in at most 64-KiB chunks without losing lifecycle', async () => {
    const root = temp();
    const file = write(root, [time(-10) + ' info [noise] initial']);
    const follower = new DesktopLogFollower();
    const catalog = new DesktopDirectoryCache();
    await inspectDesktopLogSignals(NOW, root, follower, catalog);
    const payload = accepted(1) + '\n' +
      time(2) + ' info [noise] ' + 'x'.repeat(2 * 1024 * 1024) + '\n' +
      accepted(3, OTHER) + '\n';
    fs.appendFileSync(file, payload);
    fs.utimesSync(file, new Date(NOW+3500), new Date(NOW+3500));
    const rows: string[] = [];
    const candidateScan = await (await import('../scripts/desktop-log-discovery.mjs'))
      .discoverDesktopLogFiles(root, NOW + 4000);
    const changed = await follower.scan(candidateScan.files, line => rows.push(line));
    expect(changed.maxReadBytes).toBeLessThanOrEqual(65536);
    expect(changed.bytesRead).toBeGreaterThan(2 * 1024 * 1024);
    expect(rows).toHaveLength(2);
    expect(rows.join('\n')).not.toContain('x'.repeat(100));
  });

  it('handles partial UTF-8 records over block boundaries without duplicates', async () => {
    const root = temp();
    const file = write(root, [time(-10) + ' info [noise] initial']);
    const follower = new DesktopLogFollower();
    const catalog = new DesktopDirectoryCache();
    await inspectDesktopLogSignals(NOW, root, follower, catalog);
    // Force a lifecycle event to straddle a 64-KiB read boundary.
    const padding = time(1) + ' info [noise] ' + 'y'.repeat(65535) + '\n';
    fs.appendFileSync(file, padding + accepted(2) + '\n');
    fs.utimesSync(file, new Date(NOW+3000), new Date(NOW+3000));
    const first = await inspectDesktopLogSignals(NOW+4000, root, follower, catalog);
    expect(first.events.get(SESSION)?.type).toBe('turn-start-accepted');
    fs.appendFileSync(file, accepted(5, OTHER));
    fs.utimesSync(file, new Date(NOW+5000), new Date(NOW+5000));
    const incomplete = await inspectDesktopLogSignals(NOW+6000, root, follower, catalog);
    expect(incomplete.events.has(OTHER)).toBe(false);
    fs.appendFileSync(file, '\n');
    fs.utimesSync(file, new Date(NOW+7000), new Date(NOW+7000));
    const completed = await inspectDesktopLogSignals(NOW+8000, root, follower, catalog);
    expect(completed.events.get(OTHER)?.type).toBe('turn-start-accepted');
    expect((await inspectDesktopLogSignals(NOW+9000, root, follower, catalog)).signalCount).toBe(0);
  });
});

describe('remote sessions controlled by the Windows Desktop app', () => {
  it('matches a Desktop-origin SSH session by its exact UUID, not filesystem path', () => {
    const remote = row('unknown');
    remote.sourceId = 'ssh:server';
    remote.sourceLabel = 'server';
    remote.key = 'ssh:server:' + SESSION;
    const events = newestDesktopEvents([parseDesktopLogEvent(accepted(-6), NOW)!]);
    applyDesktopLogEvidence([remote], events, NOW);
    expect(remote.status).toBe('working');
    expect(remote.statusReason).toContain('turn/start');
  });
});

describe('long running Desktop log rotation continuity', () => {
  it('retains only parsed evidence when a verbose log no longer contains start', () => {
    const memory = new DesktopLogEventCache();
    const initial = new Map([[SESSION, parseDesktopLogEvent(accepted(-40), NOW)!]]);
    const first = memory.observe(initial, NOW);
    expect(first.get(SESSION)?.type).toBe('turn-start-accepted');
    // A later scan no longer includes the old line in its bounded tail.
    const retained = memory.observe(new Map(), NOW + 18 * 60_000);
    const active = row('unknown');
    applyDesktopLogEvidence([active], retained, NOW + 18 * 60_000);
    expect(active.status).toBe('working');
    // A real completion seen after the start must suppress stale liveness.
    const completedEvent = new Map([[SESSION, parseDesktopLogEvent(
      completed(-5), NOW)!]]);
    const finished = memory.observe(completedEvent, NOW + 18 * 60_000);
    expect(finished.get(SESSION)?.type).toBe('turn-displayed-complete');
    const task = row('unknown');
    applyDesktopLogEvidence([task], finished, NOW + 18 * 60_000);
    expect(task.status).toBe('unknown');
    // The bounded long-turn ordering cache now lasts 72 hours, so an older
    // completion still suppresses historical starts through that window.
    expect(memory.observe(new Map(), NOW + 25 * 60 * 60_000).get(SESSION)?.type)
      .toBe('turn-displayed-complete');
    expect(memory.observe(new Map(), NOW + 73 * 60 * 60_000)).toEqual(new Map());
  });
});

describe('Desktop runtime completion ordering on resumed threads', () => {
  const start = newestDesktopEvents([parseDesktopLogEvent(accepted(-10), NOW)!]);

  it('recovers activity after an older, timestamp-less rollout completion', () => {
    const legacy = row('finished');
    legacy.sourceId = 'ssh:remote';
    legacy.key = 'ssh:remote:' + SESSION;
    legacy.finishedToken = '|previous-turn-with-no-timestamp';
    legacy.ageAtSourceMs = 65_000;
    applyDesktopLogEvidence([legacy], start, NOW, NOW - 1_000);
    expect(legacy.status).toBe('working');
    expect(legacy.finishedToken).toBeNull();
  });

  it('does not reopen a completed turn when the rollout was modified after native start', () => {
    const latestFinish = row('finished');
    latestFinish.finishedToken = '|current-turn-no-time';
    latestFinish.ageAtSourceMs = 300;
    applyDesktopLogEvidence([latestFinish], start, NOW, NOW - 1_000);
    expect(latestFinish.status).toBe('finished');
    expect(latestFinish.finishedToken).toBe('|current-turn-no-time');
  });

  it('keeps a remote completion when source age is unavailable and timing is ambiguous', () => {
    const remote = row('finished');
    remote.sourceId = 'ssh:remote';
    remote.finishedToken = '|untrusted-clock';
    remote.updatedAt = NOW - 200_000;
    delete remote.ageAtSourceMs;
    applyDesktopLogEvidence([remote], start, NOW, NOW - 1_000);
    expect(remote.status).toBe('finished');
  });
});

describe('persisted Desktop lifecycle evidence normalization', () => {
  it('restores a recent accepted start from strict metadata and not raw log content', () => {
    const first = new DesktopLogEventCache();
    first.observe(newestDesktopEvents([parseDesktopLogEvent(accepted(-20), NOW)!]), NOW);
    const serialized = first.snapshot(NOW);
    expect(serialized).toEqual([{ threadId: SESSION, at: NOW - 20_000,
      type: 'turn-start-accepted' }]);
    const restarted = new DesktopLogEventCache();
    restarted.restore(serialized, NOW + 10_000);
    const visible = restarted.observe(new Map(), NOW + 10_000);
    const task = row('unknown');
    applyDesktopLogEvidence([task], visible, NOW + 10_000);
    expect(task.status).toBe('working');
  });

  it('restores an uncompleted 20-hour start without fabricating a new timestamp', () => {
    const first = new DesktopLogEventCache();
    first.observe(newestDesktopEvents([parseDesktopLogEvent(accepted(-20 * 3600), NOW)!]), NOW);
    const saved = first.snapshot(NOW);
    expect(saved).toHaveLength(1);
    const restored = new DesktopLogEventCache();
    restored.restore(saved, NOW + 1000);
    const visible = row('unknown');
    applyDesktopLogEvidence([visible], restored.observe(new Map(), NOW + 1000), NOW + 1000);
    expect(visible.status).toBe('working');
    expect(visible.statusReason).toContain('未实时确认');
  });

  it('prefers a later completion after restart and will not revive stale work', () => {
    const restarted = new DesktopLogEventCache();
    restarted.restore([{ threadId: SESSION, at: NOW - 30_000,
      type: 'turn-start-accepted' }], NOW);
    restarted.observe(newestDesktopEvents([parseDesktopLogEvent(completed(-5), NOW)!]), NOW);
    const afterRestart = new DesktopLogEventCache();
    afterRestart.restore(restarted.snapshot(NOW), NOW + 10_000);
    const task = row('unknown');
    applyDesktopLogEvidence([task], afterRestart.observe(new Map(), NOW + 10_000), NOW + 10_000);
    expect(task.status).toBe('unknown');
    expect(afterRestart.snapshot(NOW + 10_000)[0]?.type).toBe('turn-displayed-complete');
  });

  it('rejects injected, expired, future and unscoped saved event fields', () => {
    const cache = new DesktopLogEventCache();
    cache.restore([
      { threadId: SESSION, at: NOW - 73 * 60 * 60_000, type: 'turn-start-accepted' },
      { threadId: SESSION, at: NOW + 20_000, type: 'turn-start-accepted' },
      { threadId: '../prompt', at: NOW, type: 'turn-start-accepted' },
      { threadId: SESSION, at: NOW, type: 'turn-displayed-complete' },
      { threadId: OTHER, at: NOW - 500, type: 'turn-start-accepted',
        prompt: 'PRIVATE USER PROMPT', secret: 'PRIVATE SSH KEY' },
    ], NOW);
    expect(cache.snapshot(NOW)).toEqual([{ threadId: OTHER, at: NOW - 500,
      type: 'turn-start-accepted' }]);
    expect(JSON.stringify(cache.snapshot(NOW))).not.toMatch(/PRIVATE/);
  });
});
