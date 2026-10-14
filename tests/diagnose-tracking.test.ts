import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
const uuid = '01a09f3b-68a4-72d3-b16b-1782ed2fbc07';
const other = '01a09f3b-68a4-72d3-b16b-1782ed2fbc08';
const script = path.resolve('scripts/diagnose-tracking.mjs');
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-diagnostic-'));
  roots.push(dir); return dir; };
function write(root: string, entries: string[], msix = false) {
  const date = new Date();
  const prefix = msix ? path.join(root, 'Packages', 'OpenAI.Codex_25.9_x64__123',
    'LocalCache', 'Local', 'Codex', 'Logs') : path.join(root, 'Codex', 'Logs');
  const folder = path.join(prefix, String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'));
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'codex-desktop-fixture-1234-t0-i1.log');
  fs.writeFileSync(file, entries.join('\n') + '\n');
  return file;
}
function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 12_000,
    env: { ...process.env, LOCALAPPDATA: root, NODE_NO_WARNINGS: '1' },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('privacy-preserving one-command tracking diagnostics', () => {
  it('detects explicit Desktop start/complete without printing any raw log content or IDs', () => {
    const root = tmp();
    const now = new Date().toISOString();
    write(root, [
      now + ' info [AppServerConnection] response_routed conversationId=' + uuid +
        ' method=turn/start errorCode=null PRIVATE_SECRET',
      now + ' info [electron-message-handler] [desktop-notifications] show turn-complete conversationId=' +
        uuid + ' turnId=' + other + ' PRIVATE_TEXT',
      now + ' error [electron-message-handler] Received turn/started for unknown conversation conversationId=' + other,
      now + ' info [AppServerConnection] response_routed conversationId=' + other +
        ' method=turn/start errorCode=-32600',
    ]);
    const output = run(root, '--thread-id', uuid, '--no-moba');
    expect(output.status, output.stderr).toBe(0);
    const obj = JSON.parse(output.stdout);
    expect(obj.desktop).toMatchObject({
      filesExamined: 1, threadScoped: true,
      discovery: {
        reason: 'readable_log_files',
        roots: expect.arrayContaining([expect.objectContaining({
          kind: 'standard', exists: true, recentCandidates: 1,
        })]),
      },
      events: { acceptedStart: 1, turnCompleteNotice: 1, failedStart: 0, unknownConversation: 0 },
      markerHints: {
        appServerConnection: 2, responseRouted: 2,
        turnStart: 3, turnComplete: 1, conversationId: 4,
      },
      recentMarkerHints: {
        logLines: 4, appServerConnection: 2, responseRouted: 2,
        turnStart: 2, turnStartedNotification: 1,
        turnCompletedNotification: 0, turnCompleteNotice: 1, conversationId: 4,
      },
    });
    expect(output.stdout).not.toMatch(/PRIVATE_SECRET|PRIVATE_TEXT|conversationId=|01a09f3b/);
    expect(output.stdout).not.toContain(root);
    expect(obj.desktop.discovery).toMatchObject({
      candidateFilesNotRead: 0, truncatedTails: 0,
      newestCandidateWriteAgeSeconds: expect.any(Number),
    });
  });

  it('keeps a start that arrives after the first poll and counts it only once', async () => {
    const root = tmp();
    const file = write(root, ['initial diagnostic noise']);
    const child = spawn(process.execPath, [script, '--duration', '1', '--no-moba'], {
      cwd: path.resolve('.'), env: { ...process.env, LOCALAPPDATA: root, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { stdout += data; });
    child.stderr.on('data', (data: string) => { stderr += data; });
    const ended = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    // Simulate Desktop accepting a turn during the observation interval.
    await new Promise(resolve => setTimeout(resolve, 600));
    // 650 KiB of later verbose logs push turn/start far outside the old
    // 320-KiB tail, but an append cursor must still observe it.
    fs.appendFileSync(file, new Date().toISOString() + ' info [AppServerConnection] response_routed ' +
      'conversationId=' + uuid + ' method=turn/start errorCode=null\n' +
      new Date().toISOString() + ' info [noise] ' + 'x'.repeat(650_000) + '\n');
    const exit = await ended;
    expect(exit, stderr).toBe(0);
    const summary = JSON.parse(stdout).desktop;
    expect(summary.events.acceptedStart).toBe(1);
    expect(summary.events.failedStart).toBe(0);
    expect(summary.latestStartAgeSeconds).not.toBeNull();
    expect(stdout).not.toContain(uuid);
    expect(stdout).not.toContain(root);
  });

  it('counts a 30-hour prior accepted start for long-running legacy threads', () => {
    const root = tmp();
    write(root, [new Date(Date.now() - 30 * 60 * 60_000).toISOString() +
      ' info [AppServerConnection] response_routed conversationId=' + uuid +
      ' method=turn/start errorCode=null']);
    const result = run(root, '--no-moba', '--thread-id', uuid);
    expect(result.status, result.stderr).toBe(0);
    const data = JSON.parse(result.stdout).desktop;
    expect(data.events.acceptedStart).toBe(1);
    expect(data.latestStartAgeSeconds).toBeGreaterThan(29 * 3600);
    expect(result.stdout).not.toContain(uuid);
  });

  it('detects MSIX log directory and safely rejects unsupported arguments', () => {
    const root = tmp();
    const now = new Date().toISOString();
    write(root, [
      now + ' info [AppServerConnection] response_routed method=turn/start conversationId=' +
        uuid + ' errorCode=null',
    ], true);
    const result = run(root, '--no-moba');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).desktop.events.acceptedStart).toBe(1);
    const bad = run(root, '--duration', '100');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).not.toContain(root);
  });
});

describe('Desktop zero-file diagnostic must identify the failing discovery stage', () => {
  it('reports a missing root rather than claiming no Desktop runtime activity', () => {
    const root = tmp();
    const output = run(root, '--no-moba');
    expect(output.status, output.stderr).toBe(0);
    const data = JSON.parse(output.stdout);
    expect(data.desktop.filesExamined).toBe(0);
    expect(data.desktop.discovery.reason).toBe('no_known_log_root');
    expect(data.desktop.discovery.roots[0]).toMatchObject({
      kind: 'standard', exists: false, accessibleDateFolders: 0,
    });
    expect(output.stdout).not.toContain(root);
  });

  it('distinguishes unsupported first-party filename from a missing directory', () => {
    const root = tmp();
    const date = new Date();
    const folder = path.join(root, 'Codex', 'Logs',
      String(date.getFullYear()), String(date.getMonth()+1).padStart(2,'0'),
      String(date.getDate()).padStart(2,'0'));
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'renamed-codex.log'), 'private token do not leak');
    const output = run(root, '--no-moba');
    expect(output.status, output.stderr).toBe(0);
    const data = JSON.parse(output.stdout);
    expect(data.desktop.discovery.reason).toBe('log_filename_not_matched');
    expect(data.desktop.discovery.roots[0]).toMatchObject({
      kind: 'standard', exists: true, anyLogFiles: 1, matchedNames: 0,
    });
    expect(output.stdout).not.toContain('renamed-codex');
    expect(output.stdout).not.toContain('private token');
  });

  it('finds a Store package even when many unrelated package folders precede it', () => {
    const root = tmp();
    const packages = path.join(root, 'Packages');
    for (let i=0; i<160; i++)
      fs.mkdirSync(path.join(packages, 'OtherApp_' + i), {recursive:true});
    write(root, [
      new Date().toISOString() + ' info [AppServerConnection] response_routed ' +
      'method=turn/start conversationId=' + uuid + ' errorCode=null',
    ], true);
    const output = run(root, '--no-moba');
    expect(output.status, output.stderr).toBe(0);
    const data = JSON.parse(output.stdout);
    expect(data.desktop.events.acceptedStart).toBe(1);
    expect(data.desktop.discovery.roots.some((r: {kind:string;recentCandidates:number}) =>
      r.kind === 'msix' && r.recentCandidates === 1)).toBe(true);
  });
});
