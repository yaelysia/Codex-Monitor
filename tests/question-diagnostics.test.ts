import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script=path.resolve('scripts/diagnose-questions.mjs');
const UUID='019aaaab-bbbb-7ccc-8ddd-111122223333';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function makeRoot() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'monitor-question-diagnostic-'));
  roots.push(root);
  const folder=path.join(root,'sessions','2026','10','16');
  fs.mkdirSync(folder,{recursive:true});
  return {root,folder,file:path.join(folder,'rollout-2026-10-16T10-00-00-'+UUID+'.jsonl')};
}
const json=(type:string,payload:object)=>JSON.stringify({type,payload})+'\n';
function run(root:string,uuid=UUID) {
  return spawnSync(process.execPath,[script,'--thread-id',uuid,'--home',root],{
    encoding:'utf8',timeout:6000,maxBuffer:64*1024,
  });
}

describe('scoped read-only VS Code question evidence diagnosis',()=>{
  it('counts structured pending requests without printing UUID, path or private input',()=>{
    const {root,file}=makeRoot();
    fs.writeFileSync(file,
      json('session_meta',{id:UUID,originator:'codex_vscode',
        cwd:'PRIVATE_WORKSPACE'})+
      json('event_msg',{type:'turn_started',turn_id:'PRIVATE_TURN'})+
      json('response_item',{type:'function_call',name:'request_user_input',
        call_id:'PRIVATE_CALL',arguments:JSON.stringify({questions:[{
          question:'PRIVATE_QUESTION'}]})}));
    const result=run(root);
    expect(result.status,result.stderr).toBe(0);
    const output=JSON.parse(result.stdout);
    expect(output).toMatchObject({
      version:1,code:'ok',client:'vscode',coverage:'persisted-pending-evidence',
      pendingBlocking:1,pendingAsync:0,
      counts:{blockingToolCalls:1,blockingToolOutputs:0},
    });
    expect(result.stdout).not.toMatch(/PRIVATE_|019aaaab|\\\\|\/sessions\/|request_user_input/);
  });

  it('does not claim a native request exists if the rollout has no persisted question evidence',()=>{
    const {root,file}=makeRoot();
    fs.writeFileSync(file,json('session_meta',{id:UUID,originator:'codex_vscode'})+
      json('event_msg',{type:'task_started'}));
    const result=run(root);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code:'ok',coverage:'no-persisted-pending-evidence',pendingBlocking:0,
    });
  });

  it('recognizes legacy event_msg agent_message question without exposing raw text',()=>{
    const {root,file}=makeRoot();
    fs.writeFileSync(file,json('session_meta',{id:UUID,originator:'codex_vscode'})+
      JSON.stringify({timestamp:'2026-10-16T02:05:00Z',
        type:'event_msg',payload:{type:'agent_message',delivery:'async',
          questions:[{question:'PRIVATE_QUESTION_BODY'}],message:'PRIVATE_TEXT'}})+'\n');
    const output=run(root);
    expect(JSON.parse(output.stdout)).toMatchObject({
      pendingAsync:1,counts:{asyncQuestionItems:1},
      coverage:'persisted-pending-evidence',
    });
    expect(output.stdout).not.toMatch(/PRIVATE_|019aaaab|\\\\|\/sessions\//);
  });

  it('recognizes a legacy async question and its subsequent user response',()=>{
    const {root,file}=makeRoot();
    const asyncItem=json('response_item',{type:'agent_message',id:'msg-a',
      delivery:'async',questions:[{question:'PRIVATE_ASK'}]});
    fs.writeFileSync(file,json('session_meta',{id:UUID,originator:'codex_vscode'})+
      asyncItem);
    expect(JSON.parse(run(root).stdout)).toMatchObject({
      coverage:'persisted-pending-evidence',pendingAsync:1,
      counts:{asyncQuestionItems:1},
    });
    fs.appendFileSync(file,json('event_msg',{type:'user_message',message:'PRIVATE_REPLY'}));
    expect(JSON.parse(run(root).stdout)).toMatchObject({
      pendingAsync:0,coverage:'no-persisted-pending-evidence',
    });
  });

  it('requires an explicit UUID and never prints contents for a missing thread',()=>{
    const {root}=makeRoot();
    const bad=run(root,'../PRIVATE');
    expect(bad.status).toBe(1);
    expect(bad.stdout).not.toContain(root);
    const absent=run(root);
    expect(absent.status).toBe(0);
    expect(JSON.parse(absent.stdout)).toEqual({version:1,code:'thread_rollout_not_found'});
  });
});
