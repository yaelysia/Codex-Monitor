import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  fs.writeFileSync(path.join(folder, 'codex-desktop-fixture-1234-t0-i1.log'),
    entries.join('\n') + '\n');
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
      events: { acceptedStart: 1, turnCompleteNotice: 1, failedStart: 0, unknownConversation: 0 },
    });
    expect(output.stdout).not.toMatch(/PRIVATE_SECRET|PRIVATE_TEXT|conversationId|01a09f3b/);
    expect(output.stdout).not.toContain(root);
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
