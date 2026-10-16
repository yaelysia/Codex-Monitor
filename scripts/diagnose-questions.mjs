#!/usr/bin/env node
/** One-shot, read-only question evidence check for a single Codex thread.
 * No raw conversation text, session UUID, directories or tool arguments are
 * printed. Does NOT connect to an App Server or answer pending requests.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_DISCOVERY = 10_000;
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_HEAD_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 32 * 1024;
const requestNames = new Set(['request_user_input','request_permissions']);
const asyncNames = new Set(['AgentMessage','agentMessage','agent_message']);
const obj = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;

function usage() {
  return 'Usage: npm run diagnose:questions -- --thread-id UUID [--home ABSOLUTE_CODEX_HOME]';
}
function flags(args) {
  let id = null, home = process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  for(let i = 0; i < args.length; i++) {
    if (args[i] === '--thread-id' && args[i+1]) id = args[++i];
    else if(args[i] === '--home' && args[i+1]) home = args[++i];
    else if(args[i] === '--help') return {help:true};
    else throw new Error('invalid_arguments');
  }
  if (!id || !UUID.test(id) || !path.isAbsolute(home)) throw new Error('invalid_arguments');
  return {id:id.toLowerCase(),home};
}
async function locate(root, id) {
  const queue = [{folder:path.join(root,'sessions'),depth:0}];
  let visited = 0;
  while(queue.length && visited < MAX_DISCOVERY) {
    const {folder,depth} = queue.shift();
    let entries;
    try { entries = await fs.readdir(folder, {withFileTypes:true}); }
    catch { continue; }
    entries.sort((a,b)=>b.name.localeCompare(a.name));
    for(const entry of entries) {
      if (++visited > MAX_DISCOVERY) break;
      if(entry.isDirectory() && depth < 5) queue.push({folder:path.join(folder,entry.name),depth:depth+1});
      else if(entry.isFile() && entry.name.toLowerCase().endsWith(id+'.jsonl'))
        return path.join(folder,entry.name);
    }
  }
  return null;
}
function stableId(objValue, stamp) {
  if (typeof objValue?.id === 'string' && objValue.id.length < 257 && objValue.id) return objValue.id;
  return typeof stamp === 'string' && stamp.length < 257 && Number.isFinite(Date.parse(stamp))
    ? stamp : null;
}
function evidence(text, clippedStart) {
  const lines=text.split(/\r?\n/);
  if(clippedStart) lines.shift();
  const counts={blockingToolCalls:0,blockingToolOutputs:0,asyncToolCalls:0,
    asyncQuestionItems:0,terminalEvents:0,userMessages:0,transientRequestEvents:0};
  const pendingBlocking=new Set();
  const pendingAsync=new Set();
  for(const line of lines) {
    if(line.length > MAX_LINE_BYTES) continue;
    let row;
    try {row=JSON.parse(line);}catch{continue;}
    const payload=obj(row?.payload);
    if(!payload) continue;
    const kind=payload.type;
    const message = item => {
      if(!asyncNames.has(item?.type) || item.delivery !== 'async' ||
          !Array.isArray(item.questions) || !item.questions.length) return;
      counts.asyncQuestionItems++;
      const id=stableId(item,row.timestamp);
      if(id) pendingAsync.add(id);
    };
    if(row.type==='response_item') {
      if(kind==='function_call' || kind==='custom_tool_call') {
        const name=String(payload.name || '').split('.').pop();
        if(name === 'request_user_input_async') counts.asyncToolCalls++;
        if(requestNames.has(name)) {
          counts.blockingToolCalls++;
          if(typeof payload.call_id==='string' && payload.call_id.length<=256)
            pendingBlocking.add(payload.call_id);
        }
      } else if(kind==='function_call_output' || kind==='custom_tool_call_output') {
        if(pendingBlocking.delete(payload.call_id)) counts.blockingToolOutputs++;
      } else if(asyncNames.has(kind)) message(payload);
      else if(kind==='message' && payload.role==='user'){
        counts.userMessages++;
        pendingAsync.clear();
      }
    } else if(row.type==='event_msg') {
      if(kind==='item_completed') {
        const item=obj(payload.item);
        if(item?.type==='UserMessage'||item?.type==='userMessage'){
          counts.userMessages++;pendingAsync.clear();
        }
        message(item);
      } else if(kind==='user_message'){counts.userMessages++;pendingAsync.clear();}
      else if(['turn_started','task_started','turn_complete','task_complete','turn_aborted'].includes(kind)){
        pendingBlocking.clear();
        if(['turn_complete','task_complete','turn_aborted'].includes(kind))
          counts.terminalEvents++;
      } else if(['request_user_input','request_permissions','exec_approval_request'].includes(kind))
        counts.transientRequestEvents++;
    }
  }
  return {counts,pendingBlocking:pendingBlocking.size,
    pendingAsync:pendingAsync.size};
}
export async function diagnose(options) {
  const file=await locate(options.home,options.id);
  if(!file) return {version:1,code:'thread_rollout_not_found'};
  const stat=await fs.stat(file);
  if(!stat.isFile() || stat.size < 1) return {version:1,code:'unreadable_rollout'};
  const handle=await fs.open(file,'r');
  let head='',tail='';
  const length=Math.min(stat.size,MAX_TAIL_BYTES);
  try {
    const front=Buffer.alloc(Math.min(stat.size,MAX_HEAD_BYTES));
    const back=Buffer.alloc(length);
    const [a,b]=await Promise.all([
      handle.read(front,0,front.length,0),
      handle.read(back,0,back.length,stat.size-length),
    ]);
    head=front.subarray(0,a.bytesRead).toString('utf8');
    tail=back.subarray(0,b.bytesRead).toString('utf8');
  } finally {await handle.close();}
  const origin=/"originator"\s*:\s*"([^"\\]{1,100})"/.exec(head)?.[1]?.toLowerCase();
  const client=origin?.includes('vscode')?'vscode':origin?.includes('desktop')?'desktop':
    origin?.includes('cli')||origin?.includes('tui')?'terminal':'unknown';
  const found=evidence(tail,stat.size>length);
  return {version:1,code:'ok',client,tailClipped:stat.size>length,
    tailLimitBytes:MAX_TAIL_BYTES,rolloutAgeSeconds:Math.max(0,
      Math.round((Date.now()-stat.mtimeMs)/1000)),
    ...found,coverage:found.pendingBlocking||found.pendingAsync
      ? 'persisted-pending-evidence' : 'no-persisted-pending-evidence',
    limitation:'VS Code App Server requests and approvals may be transient and absent from JSONL'};
}
async function main(args=process.argv.slice(2)) {
  let opts;
  try {opts=flags(args);}catch {
    process.stderr.write(usage()+'\n');
    process.exitCode=1;
    return;
  }
  if(opts.help){process.stdout.write(usage()+'\n');return;}
  try { process.stdout.write(JSON.stringify(await diagnose(opts),null,2)+'\n'); }
  catch {process.stdout.write(JSON.stringify({version:1,code:'diagnosis_unavailable'})+'\n');process.exitCode=1;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
