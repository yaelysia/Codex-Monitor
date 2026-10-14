import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RecentReplyExcerpt, ScanResponse, Settings } from '../src/shared/types';
import { latestReplyExcerpt, SHORT_TAIL_BYTES, MAX_TAIL_BYTES, validRolloutPath } from '../src/shared/reply-excerpt';
import { resolveLocalRoot } from './local';
import { runCollector } from './collector';

let previewScript: Promise<string> | null = null;

function scannerScript(): Promise<string> {
  if (!previewScript) {
    const filename = app.isPackaged
      ? path.join(process.resourcesPath, 'preview.py')
      : path.join(app.getAppPath(), 'collector', 'preview.py');
    previewScript = fs.readFile(filename, 'utf8').catch(err => {
      previewScript = null;
      throw err;
    });
  }
  return previewScript;
}

async function readTail(handle: fs.FileHandle, size: number, budget: number): Promise<RecentReplyExcerpt> {
  const length = Math.min(size, budget);
  const bytes = Buffer.alloc(length);
  let received = 0;
  while (received < length) {
    const next = await handle.read(bytes, received, length - received, size - length + received);
    if (!next.bytesRead) break;
    received += next.bytesRead;
  }
  return latestReplyExcerpt(bytes.subarray(0, received).toString('utf8'), size > length);
}

/** Read exactly one known session file; never accepts arbitrary paths from a renderer. */
export async function readLocalRecentReply(root: string, relativePath: string): Promise<RecentReplyExcerpt> {
  if (!validRolloutPath(relativePath)) throw new Error('Invalid session rollout path');
  const folder = await fs.realpath(path.join(root, 'sessions'));
  const file = await fs.realpath(path.join(folder, ...relativePath.split('/')));
  if (!file.startsWith(folder + path.sep)) throw new Error('Session file is outside CODEX_HOME');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const short = await readTail(handle, stat.size, SHORT_TAIL_BYTES);
    if (short.text || stat.size <= SHORT_TAIL_BYTES) return short;
    return readTail(handle, stat.size, MAX_TAIL_BYTES);
  } finally { await handle.close(); }
}

function isRecentReply(value: unknown): value is RecentReplyExcerpt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const phase = row.phase;
  return (row.text === null || typeof row.text === 'string' && row.text.length <= 1100) &&
    (phase === null || phase === 'final_answer' || phase === 'commentary' ||
      phase === 'partial_answer' || phase === 'unspecified') &&
    (row.timestamp === null || typeof row.timestamp === 'string' && row.timestamp.length <= 120) &&
    typeof row.truncated === 'boolean';
}

/** Resolves the selected session against the last trusted scan instead of renderer-supplied file paths. */
export async function readRecentReply(sessionKey: string, scan: ScanResponse | null,
  settings: Settings): Promise<RecentReplyExcerpt> {
  const source = scan?.sources.find(source => source.sessions.some(session => session.key === sessionKey));
  if (!source || source.error) throw new Error('Session is no longer available in the current scan');
  const session = source.sessions.find(row => row.key === sessionKey);
  const relativePath = session?.rolloutPath;
  if (!relativePath || !validRolloutPath(relativePath)) throw new Error('Selected session has no valid rollout path');
  if (source.kind === 'local') return readLocalRecentReply(resolveLocalRoot(settings.localRoot), relativePath);

  const python = await scannerScript();
  const options = { rolloutPath: relativePath };
  let output: unknown;
  if (source.kind === 'wsl') {
    const distro = source.id.slice(4);
    output = await runCollector('wsl.exe', ['-d', distro, '--', 'python3', '-'],
      python, settings.wslRoots[distro] || '', options);
  } else {
    const host = settings.remotes.find(host => 'ssh:' + host.id === source.id);
    if (!host) throw new Error('The SSH source is no longer configured');
    output = await runCollector('ssh', [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'ConnectionAttempts=1', host.alias, 'python3', '-',
    ], python, host.root, options);
  }
  if (!isRecentReply(output)) throw new Error('Unexpected preview scanner response');
  return output;
}
