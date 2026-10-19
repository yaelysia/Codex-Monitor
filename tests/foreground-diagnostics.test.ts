import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const diagnostic=path.resolve('scripts/diagnose-foreground.mjs');
const run=(code:string)=>spawnSync(process.execPath,['--input-type=module','-e',code],{
  cwd:path.resolve('.'),encoding:'utf8',timeout:5000,maxBuffer:16*1024,
});

describe('privacy-safe standalone native foreground health sampler',()=>{
  it('reports only native app category histograms, not raw HWND/PID/tab/title values',()=>{
    const result=run(`
      import {summarizeForegroundEvents} from './scripts/diagnose-foreground.mjs';
      const raw=[
        JSON.stringify({type:'foreground',at:1800000000000,app:'vscode',
          hwnd:'PRIVATE_HWND',pid:12345,tabId:'PRIVATE_TAB',title:'PRIVATE_TITLE'}),
        JSON.stringify({type:'foreground',at:1800000000001,app:'vscode',pid:99}),
        JSON.stringify({type:'foreground',at:1800000000002,app:'other',pid:99}),
        JSON.stringify({type:'foreground',at:1800000000003,app:'terminal',pid:77}),
        JSON.stringify({type:'secret',app:'vscode',content:'PRIVATE_TRANSCRIPT'}),
        'malformed',
      ];
      console.log(JSON.stringify(summarizeForegroundEvents(raw)));
    `);
    expect(result.status,result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      samples:4,categories:{vscode:2,desktop:0,terminal:1,other:1},
      categoryTransitions:2,lastAppCategory:'terminal',
    });
    expect(result.stdout).not.toMatch(/PRIVATE_|pid|hwnd|title|tabId|content/);
  });

  it('does not accept corrupt or oversized native messages as category data',()=>{
    const res=run(`
      import {parseForegroundCategory} from './scripts/diagnose-foreground.mjs';
      const checks=[
        'garbled',JSON.stringify({type:'foreground',at:'invalid',app:'vscode'}),
        JSON.stringify({type:'foreground',at:123,app:'unexpected'}),
        'x'.repeat(6000),JSON.stringify({type:'foreground',at:1000,app:'desktop',pid:99}),
      ];
      console.log(JSON.stringify(checks.map(parseForegroundCategory)));
    `);
    expect(res.status,res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual([null,null,null,null,'desktop']);
  });

  it('supports help without starting native OS watchers',()=>{
    const out=spawnSync(process.execPath,[diagnostic,'--help'],{
      encoding:'utf8',timeout:5000,
    });
    expect(out.status,out.stderr).toBe(0);
    expect(out.stdout).toContain('diagnose:foreground');
    const invalid=spawnSync(process.execPath,[diagnostic,'--duration','1000'],{
      encoding:'utf8',timeout:5000,
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stdout).toBe('');
  });
});
