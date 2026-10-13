#!/usr/bin/env node
/** One-command read-only diagnostics for Codex Desktop lifecycle and Moba tabs.
 * No session transcript, terminal contents, account data, tab captions or raw
 * log lines are printed. Not a real-time App Server subscription.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverDesktopLogFiles } from './desktop-log-discovery.mjs';
import { DesktopLogFollower } from './desktop-log-follower.mjs';

const execAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const RECENT_LOG_MS = 5 * 60_000;
const LONG_TURN_HISTORY_MS = 72 * 60 * 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function options(args) {
  const result = { duration: 0, threadId: null, skipMoba: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { result.help = true; continue; }
    if (args[i] === '--no-moba') { result.skipMoba = true; continue; }
    const [flag, inline] = args[i].split('=', 2);
    if (!['--duration', '--thread-id'].includes(flag))
      throw new Error('Unknown diagnostic option');
    const value = inline ?? args[++i];
    if (!value) throw new Error('Option value missing');
    if (flag === '--duration') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 45) throw new Error('Invalid duration');
      result.duration = n;
    } else if (!UUID.test(value)) throw new Error('Invalid thread UUID');
    else result.threadId = value.toLowerCase();
  }
  return result;
}

function candidate(line, now, target) {
  if (line.length > 10_000) return null;
  const timeMatch = /^(\S+)\s+(info|warning|error)\s+/.exec(line);
  const at = timeMatch ? Date.parse(timeMatch[1]) : NaN;
  if (!Number.isFinite(at) || now - at > LONG_TURN_HISTORY_MS || at > now + 5000) return null;
  const id = /\bconversationId=([0-9a-f-]{36})(?=\s|$)/i.exec(line)?.[1]?.toLowerCase();
  if (!id || !UUID.test(id) || (target && id !== target)) return null;
  let type;
  if (line.includes('[AppServerConnection]') && /\bresponse_routed\b/.test(line) &&
      /\bmethod=turn\/start(?=\s|$)/.test(line)) {
    type = /\berrorCode=null(?=\s|$)/.test(line) ? 'acceptedStart' : 'failedStart';
  } else if (line.includes('[desktop-notifications]') &&
      line.includes('show turn-complete')) type = 'turnCompleteNotice';
  else if (/Received turn\/(started|completed) for unknown conversation/.test(line))
    type = 'unknownConversation';
  else return null;
  return { at, type, id };
}

async function inspectLogs(root, now, target, seenEvents, follower) {
  const discovered = await discoverDesktopLogFiles(root, now);
  const files = discovered.files;
  const counts = { acceptedStart: 0, failedStart: 0, turnCompleteNotice: 0, unknownConversation: 0 };
  const latest = { acceptedStart: null, turnCompleteNotice: null };
  // Syntax hints only: not proof that any event belongs to a live thread.
  // Useful when the GUI changes its log line format between versions.
  const markerHints = { appServerConnection: 0, responseRouted: 0,
    turnStart: 0, turnComplete: 0, conversationId: 0 };
  // Syntax-only hints in the last five minutes. Do NOT turn these into
  // session states; arbitrary log messages and untrusted text can contain
  // event-like words.
  const recentMarkerHints = {
    logLines: 0, appServerConnection: 0, responseRouted: 0,
    turnStart: 0, turnStartedNotification: 0, turnCompletedNotification: 0,
    turnCompleteNotice: 0, conversationId: 0,
  };
  const followed = await follower.scan(files, line => {
        if (line.length <= 10_000) {
          if (line.includes('[AppServerConnection]')) markerHints.appServerConnection++;
          if (line.includes('response_routed')) markerHints.responseRouted++;
          if (line.includes('turn/start')) markerHints.turnStart++;
          if (line.includes('turn/completed') || line.includes('show turn-complete'))
            markerHints.turnComplete++;
          if (line.includes('conversationId=')) markerHints.conversationId++;
        }
        const prefix = /^(\S+)\s+(?:info|warning|error)\s+\[/.exec(line);
        const lineAt = prefix ? Date.parse(prefix[1]) : NaN;
        if (line.length <= 10_000 && Number.isFinite(lineAt) &&
            lineAt <= now + 5000 && now - lineAt >= 0 &&
            now - lineAt <= RECENT_LOG_MS) {
          recentMarkerHints.logLines++;
          if (line.includes('[AppServerConnection]')) {
            recentMarkerHints.appServerConnection++;
            if (/\bresponse_routed\b/.test(line)) recentMarkerHints.responseRouted++;
          }
          if (/\bturn\/start\b/.test(line)) recentMarkerHints.turnStart++;
          if (/\bturn\/started\b/.test(line)) recentMarkerHints.turnStartedNotification++;
          if (/\bturn\/completed\b/.test(line)) recentMarkerHints.turnCompletedNotification++;
          if (line.includes('[desktop-notifications]') && line.includes('show turn-complete'))
            recentMarkerHints.turnCompleteNotice++;
          if (line.includes('conversationId=')) recentMarkerHints.conversationId++;
        }
        const event = candidate(line, now, target);
        if (!event) return;
        const unique = event.at + '|' + event.type + '|' + event.id;
        // Keep a single identity across successive polls; a verbose log can
        // rotate the event out of its bounded tail before the final poll.
        if (seenEvents.has(unique)) return;
        seenEvents.add(unique);
        counts[event.type]++;
        if (event.type in latest)
          latest[event.type] = Math.max(latest[event.type] ?? 0, event.at);
  });
  const scannedFiles = followed.trackedFiles;
  const truncatedTails = followed.truncatedTails;
  const exists = discovered.roots.filter(root => root.exists).length;
  const logNames = discovered.roots.reduce((count, root) => count + root.matchedNames, 0);
  const anyLogs = discovered.roots.reduce((count, root) => count + root.anyLogFiles, 0);
  const reason = !discovered.validLocalAppData ? 'local_app_data_missing' :
    exists === 0 ? 'no_known_log_root' :
    anyLogs === 0 ? 'no_log_files_in_scanned_dates' :
    logNames === 0 ? 'log_filename_not_matched' :
    files.length === 0 ? 'no_recent_log_candidates' :
    scannedFiles === 0 ? 'log_files_unreadable' : 'readable_log_files';
  return {
    filesExamined: scannedFiles, candidatesFound: files.length,
    discovery: { reason, roots: discovered.roots,
      newestCandidateWriteAgeSeconds: files.length
        ? Math.max(0, Math.round((now - files[0].mtimeMs) / 1000)) : null,
      candidateFilesNotRead: Math.max(0, files.length - scannedFiles),
      truncatedTails,
      unreadBacklogFiles: followed.backlogFiles,
    },
    markerHints,
    recentMarkerHints,
    events: counts,
    latestStartAgeSeconds: latest.acceptedStart == null
      ? null : Math.max(0, Math.round((now-latest.acceptedStart)/1000)),
    latestCompleteAgeSeconds: latest.turnCompleteNotice == null
      ? null : Math.max(0, Math.round((now-latest.turnCompleteNotice)/1000)),
    threadScoped: !!target,
  };
}

async function inspectMoba() {
  if (process.platform !== 'win32')
    return { available: false, reason: 'windows_only' };
  const command = path.join(path.dirname(fileURLToPath(import.meta.url)), '..',
    'collector', 'window-tracker.ps1');
  try {
    const { stdout } = await execAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', command, '-Mode', 'inspect-tabs',
    ], { timeout: 15_000, maxBuffer: 8192, windowsHide: true });
    const lines = stdout.split(/\r?\n/);
    const data = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
      .find(obj => obj?.type === 'tab-probe');
    if (!data) return { available: false, reason: 'native_probe_unavailable' };
    const allowed = (name, max = 1000) => Number.isInteger(data[name]) &&
      data[name] >= 0 && data[name] <= max ? data[name] : 0;
    const sanitized = entry => {
      const number = name => Number.isInteger(entry[name]) &&
        entry[name] >= 0 && entry[name] <= 1000 ? entry[name] : 0;
      return {
        index: number('index'),
        identified: entry.identified === true,
        provider: ['uia', 'msaa', 'none'].includes(entry.provider) ? entry.provider : 'none',
        reason: /^[a-z_]{1,80}$/.test(entry.reason ?? '') ? entry.reason : 'not_identified',
        count: number('count'),
        uiaTabItems: number('uiaTabItems'),
        msaaGroups: number('msaaGroups'),
        msaaMaxTabs: number('msaaMaxTabs'),
        msaaSelected: number('msaaSelected'),
        msaaDuplicateNames: entry.msaaDuplicateNames === true,
        nativeTabLikeChildren: number('nativeTabLikeChildren'),
      };
    };
    const bool = value => value === true;
    const windowPolicy = entry => ({
      index: Number.isInteger(entry.index) && entry.index >= 1 && entry.index <= 6 ? entry.index : 0,
      mainCandidate: bool(entry.mainCandidate),
      hasOwner: bool(entry.hasOwner),
      toolWindow: bool(entry.toolWindow),
      geometry: ['large', 'small', 'unavailable'].includes(entry.geometry)
        ? entry.geometry : 'unavailable',
      minimized: bool(entry.minimized),
    });
    return {
      available: true,
      ...sanitized(data),
      visibleProcessWindows: allowed('visibleProcessWindows'),
      mainCandidates: allowed('mainCandidates'),
      selectableCandidates: allowed('selectableCandidates'),
      visibleWindows: Array.isArray(data.visibleWindows)
        ? data.visibleWindows.slice(0, 6).filter(e => e && typeof e === 'object')
          .map(windowPolicy) : [],
      rejectedProbes: Array.isArray(data.rejectedProbes)
        ? data.rejectedProbes.slice(0, 2).filter(e => e && typeof e === 'object')
          .map(sanitized) : [],
      candidates: Array.isArray(data.candidates)
        ? data.candidates.slice(0, 6).filter(e => e && typeof e === 'object')
          .map(sanitized) : [],
    };
  } catch { return { available: false, reason: 'probe_error_or_timeout' }; }
}

async function run(args) {
  const opts = options(args);
  if (opts.help) {
    console.log('npm run diagnose:tracking -- [--duration 15] [--thread-id UUID] [--no-moba]');
    return;
  }
  const localAppData = process.env.LOCALAPPDATA || '';
  const stopAt = Date.now() + opts.duration * 1000;
  let logSummary;
  // Report unique lifecycle events observed across the ENTIRE duration, not
  // only the last log tail. Otherwise rotating logs can hide a captured start.
  const seenEvents = new Set();
  const follower = new DesktopLogFollower();
  const markerTotals = {};
  const recentTotals = {};
  let maxTruncatedTails = 0;
  let maxUnreadBacklogFiles = 0;
  const totals = { acceptedStart: 0, failedStart: 0, turnCompleteNotice: 0, unknownConversation: 0 };
  let latestStartAt = null;
  let latestCompleteAt = null;
  while (true) {
    const sampledAt = Date.now();
    logSummary = await inspectLogs(localAppData, sampledAt, opts.threadId, seenEvents, follower);
    for (const name of Object.keys(totals)) totals[name] += logSummary.events[name];
    for (const [name, value] of Object.entries(logSummary.markerHints))
      markerTotals[name] = (markerTotals[name] ?? 0) + value;
    for (const [name, value] of Object.entries(logSummary.recentMarkerHints))
      recentTotals[name] = (recentTotals[name] ?? 0) + value;
    maxTruncatedTails = Math.max(maxTruncatedTails, logSummary.discovery.truncatedTails);
    maxUnreadBacklogFiles = Math.max(maxUnreadBacklogFiles, logSummary.discovery.unreadBacklogFiles);
    if (logSummary.latestStartAgeSeconds !== null) {
      const at = sampledAt - logSummary.latestStartAgeSeconds * 1000;
      latestStartAt = Math.max(latestStartAt ?? 0, at);
    }
    if (logSummary.latestCompleteAgeSeconds !== null) {
      const at = sampledAt - logSummary.latestCompleteAgeSeconds * 1000;
      latestCompleteAt = Math.max(latestCompleteAt ?? 0, at);
    }
    if (opts.duration === 0 || Date.now() >= stopAt) break;
    await sleep(Math.min(4000, Math.max(0, stopAt - Date.now())));
    // Always include the closing boundary, even when the sleep reaches stopAt.
  }
  logSummary.events = totals;
  logSummary.markerHints = markerTotals;
  logSummary.recentMarkerHints = recentTotals;
  logSummary.discovery.truncatedTails = maxTruncatedTails;
  logSummary.discovery.unreadBacklogFiles = maxUnreadBacklogFiles;
  logSummary.latestStartAgeSeconds = latestStartAt === null ? null :
    Math.max(0, Math.round((Date.now() - latestStartAt) / 1000));
  logSummary.latestCompleteAgeSeconds = latestCompleteAt === null ? null :
    Math.max(0, Math.round((Date.now() - latestCompleteAt) / 1000));
  const moba = opts.skipMoba ? { available: false, reason: 'skipped' } : await inspectMoba();
  console.log(JSON.stringify({ diagnosticVersion: 1, desktop: logSummary, moba }, null, 2));
}

run(process.argv.slice(2)).catch(() => {
  console.error('Tracking diagnostic could not complete (no raw data printed)');
  process.exitCode = 1;
});
