#!/usr/bin/env node
/** One-shot, read-only Windows foreground observer health probe.
 * Starts the same native helper as Monitor but never prints HWNDs, PIDs,
 * process start times, tab IDs, titles, transcript text or file paths.
 * The native watcher emits foreground samples; this script reports only
 * the category histogram and stream health. Does not change any UI focus.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APPS = ['vscode','desktop','terminal','other'];
const DEFAULT_DURATION_SECONDS = 20;
const MAX_LINE_BYTES = 4096;
const LIMIT_SECONDS = 60;

export function parseForegroundCategory(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_LINE_BYTES) return null;
  let event;
  try { event = JSON.parse(raw); } catch { return null; }
  if (event?.type !== 'foreground' || !APPS.includes(event.app) ||
      typeof event.at !== 'number' || !Number.isFinite(event.at)) return null;
  // Parse no other fields. The native event contains private OS identities.
  return event.app;
}

export function summarizeForegroundEvents(lines) {
  const counts = { vscode:0,desktop:0,terminal:0,other:0 };
  let lastCategory = null, transitions = 0, total = 0;
  for (const line of lines) {
    const category = parseForegroundCategory(line);
    if (category === null) continue;
    if (total && lastCategory !== category) transitions++;
    counts[category]++;
    lastCategory = category;
    total++;
  }
  return {samples:total,categories:counts,categoryTransitions:transitions,
    lastAppCategory:lastCategory};
}

function args(argv) {
  let duration = DEFAULT_DURATION_SECONDS;
  for (let i=0;i<argv.length;i++) {
    if (argv[i] === '--help') return {help:true,duration};
    if (argv[i] !== '--duration' || !argv[i+1] ||
        !/^\d+$/.test(argv[i+1])) throw new Error('invalid_arguments');
    duration=Number(argv[++i]);
    if (duration<5 || duration>LIMIT_SECONDS) throw new Error('invalid_arguments');
  }
  return {help:false,duration};
}

export async function diagnoseForeground({duration=DEFAULT_DURATION_SECONDS,
  platform=process.platform, createChild=spawn}={}) {
  if (platform !== 'win32') return {version:1,status:'windows_only'};
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
    '..','collector','window-tracker.ps1');
  let child;
  try {
    child = createChild('powershell.exe', [
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',script,'-Mode','watch',
    ], {windowsHide:true,stdio:['ignore','pipe','ignore']});
  } catch {
    return {version:1,status:'native_observer_start_failed'};
  }
  return new Promise(resolve => {
    const counts = {vscode:0,desktop:0,terminal:0,other:0};
    let samples=0, transitions=0, lastAppCategory=null;
    let partial='', settled=false, failed=false;
    const finish=(reason) => {
      if (settled) return;
      settled=true;
      clearTimeout(watchdog);
      try {child.kill();}catch{}
      resolve({version:1,status:reason,samples,
        categories:counts,categoryTransitions:transitions,lastAppCategory,
        hint:samples===0 ? 'no_valid_native_samples' :
          counts.vscode===0 ? 'switch_to_vscode_during_probe' :
          'vscode_foreground_samples_present'});
    };
    const watchdog=setTimeout(() => finish(samples ? 'ok' :
      failed ? 'native_observer_start_failed' : 'native_observer_no_samples'),
      duration*1000);
    watchdog.unref?.();
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', chunk => {
      if (settled) return;
      partial+=String(chunk);
      if (partial.length>MAX_LINE_BYTES*4) {
        partial='';
        return;
      }
      let at;
      while ((at=partial.indexOf('\n'))>=0) {
        const line=partial.slice(0,at).trim();
        partial=partial.slice(at+1);
        const category=parseForegroundCategory(line);
        if (!category) continue;
        if (samples>0 && lastAppCategory!==category) transitions++;
        counts[category]++;
        samples++;
        lastAppCategory=category;
      }
    });
    child.once?.('error',()=>{failed=true;finish('native_observer_start_failed');});
    child.once?.('exit',()=>finish(samples ? 'native_observer_exited' :
      'native_observer_start_failed'));
  });
}

async function main() {
  let options;
  try {options=args(process.argv.slice(2));}catch {
    process.stderr.write('Usage: npm run diagnose:foreground -- --duration 20\n');
    process.exitCode=1;
    return;
  }
  if (options.help) {
    process.stdout.write('Usage: npm run diagnose:foreground -- --duration 20\n');
    return;
  }
  process.stdout.write(JSON.stringify(await diagnoseForeground(options),null,2)+'\n');
}
if (process.argv[1] &&
    import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) await main();
