import { describe, expect, it } from 'vitest';
import { RunningContinuity, TRANSIENT_RUNNING_GAP_MS } from '../src/shared/running-continuity';
import type { ScanResponse, SessionRecord, SourceResult, SessionStatus } from '../src/shared/types';

const NOW=1_800_000_000_000;
function row(status:SessionStatus='working',key='local:long-turn',
  details:Partial<SessionRecord>={}):SessionRecord {
  return {
    id:key.split(':').at(-1)!,key,sourceId:'local',sourceLabel:'Windows',
    title:'Long turn',workspace:null,clientKind:'vscode',
    status,statusReason:status,updatedAt:NOW,startedAt:null,
    byteSize:500,rolloutPath:'2026/10/16/rollout-long-turn.jsonl',
    ageAtSourceMs:1000,...details,
  };
}
function scan(at:number, sessions:SessionRecord[],error:string|null=null):ScanResponse {
  return {scannedAt:at,sources:[{
    id:'local',kind:'local',label:'Windows',capturedAt:at,
    error,sessions,
  }]};
}
function keyStatus(view:ScanResponse,key='local:long-turn'):SessionStatus|undefined{
  return view.sources[0]?.sessions.find(session=>session.key===key)?.status;
}

describe('bounded continuity for transient missing activity',()=>{
  it('retains one working row through short success-only unknowns, then expires irreversibly',()=>{
    const tracker=new RunningContinuity();
    const first=scan(NOW,[row()]);
    const unresolved=scan(NOW+3000,[row('unknown')]);
    const kept=tracker.project(first,unresolved,NOW+3000);
    expect(keyStatus(kept)).toBe('working');
    expect(kept.sources[0]?.sessions[0]).toMatchObject({
      evidenceKind:'retained-activity',
    });
    expect(kept.sources[0]?.sessions[0]?.statusReason).toContain('15 秒');
    expect(keyStatus(unresolved)).toBe('unknown');
    expect(keyStatus(first)).toBe('working');

    const more=tracker.project(kept,scan(NOW+13_000,[row('unknown')]),NOW+13_000);
    expect(keyStatus(more)).toBe('working');
    const expired=tracker.project(more,
      scan(NOW+3000+TRANSIENT_RUNNING_GAP_MS,[row('unknown')]),
      NOW+3000+TRANSIENT_RUNNING_GAP_MS);
    expect(keyStatus(expired)).toBe('unknown');
    const noRenew=tracker.project(expired,
      scan(NOW+3000+TRANSIENT_RUNNING_GAP_MS+3000,[row('unknown')]),
      NOW+3000+TRANSIENT_RUNNING_GAP_MS+3000);
    expect(keyStatus(noRenew)).toBe('unknown');
  });

  it.each(['finished','waiting','failed','interrupted'] as const)(
    'immediately reports explicit %s and never invents a running turn',state=>{
      const tracker=new RunningContinuity();
      const original=scan(NOW,[row()]);
      const short=tracker.project(original,scan(NOW+2000,[row('unknown')]),NOW+2000);
      const terminal=scan(NOW+3000,[row(state,'local:long-turn',{
        finishedToken:state==='finished'?'turn|done':null,
        failedToken:state==='failed'?'turn|error':null,
        interruptedToken:state==='interrupted'?'turn|abort':null,
        pendingQuestionToken:state==='waiting'?'blocking:ask':null,
      })]);
      const finished=tracker.project(short,terminal,NOW+3000);
      expect(keyStatus(finished)).toBe(state);
      expect(keyStatus(tracker.project(finished,
        scan(NOW+4000,[row('unknown')]),NOW+4000))).toBe('unknown');
    },
  );

  it('never treats pending async questions or terminal markers masked by unknown as running',()=>{
    const tracker=new RunningContinuity();
    const working=scan(NOW,[row()]);
    const blocked=scan(NOW+3000,[row('unknown',{
      pendingQuestionToken:'async:question-one',
    })]);
    expect(keyStatus(tracker.project(working,blocked,NOW+3000))).toBe('unknown');
    const failed=scan(NOW+5000,[row('unknown',{
      failedToken:'event:error',
    })]);
    expect(keyStatus(tracker.project(working,failed,NOW+5000))).toBe('unknown');
    expect(keyStatus(tracker.project(working,
      scan(NOW+6000,[row('unknown')]),NOW+6000,
      new Set(['long-turn'])))).toBe('unknown');
  });

  it('retains a briefly absent pinned or indexed session, but never invents a new session',()=>{
    const tracker=new RunningContinuity();
    const original=scan(NOW,[row()]);
    const empty=scan(NOW+3000,[]);
    const held=tracker.project(original,empty,NOW+3000);
    expect(held.sources[0]?.sessions).toHaveLength(1);
    expect(keyStatus(held)).toBe('working');
    expect(empty.sources[0]?.sessions).toHaveLength(0);
    const expired=tracker.project(held,scan(NOW+18_000,[]),NOW+18_000);
    expect(expired.sources[0]?.sessions).toEqual([]);
    expect(tracker.project(expired,scan(NOW+19_000,[]),NOW+19_000)
      .sources[0]?.sessions).toEqual([]);
    expect(tracker.project(null,scan(NOW+20_000,[]),NOW+20_000)
      .sources[0]?.sessions).toEqual([]);
  });

  it('does not hold a subagent or any session without a trustworthy file/client locator',()=>{
    const tracker=new RunningContinuity();
    const old=scan(NOW,[
      row('working','local:child',{isSubagent:true}),
      row('working','local:unlocated',{rolloutPath:null,clientKind:'unknown'}),
    ]);
    expect(tracker.project(old,scan(NOW+2000,[]),NOW+2000)
      .sources[0]?.sessions).toEqual([]);
  });

  it('stops immediately on a failed/stale source rather than claiming disconnected tasks are still live',()=>{
    const tracker=new RunningContinuity();
    const original=scan(NOW,[row()]);
    const interrupted=tracker.project(original,scan(NOW+3000,[row('unknown')]),NOW+3000);
    const error=scan(NOW+4000,[row('unknown')],'SSH timeout');
    expect(keyStatus(tracker.project(interrupted,error,NOW+4000))).toBe('unknown');
    const after=tracker.project(error,scan(NOW+5000,[row('unknown')]),NOW+5000);
    expect(keyStatus(after)).toBe('unknown');
  });

  it('holds only a bounded number of missing parent rows on large scans',()=>{
    const tracker=new RunningContinuity();
    const rows=Array.from({length:60},(_,i)=>row('working','local:'+i));
    const old=scan(NOW,rows);
    const next=tracker.project(old,scan(NOW+2000,[]),NOW+2000);
    expect(next.sources[0]?.sessions).toHaveLength(16);
  });

  it('a later real working scan resets a previous gap and can start a fresh bounded episode',()=>{
    const tracker=new RunningContinuity();
    const a=scan(NOW,[row()]);
    const b=tracker.project(a,scan(NOW+3000,[row('unknown')]),NOW+3000);
    const recovered=tracker.project(b,scan(NOW+5000,[row('working')]),NOW+5000);
    expect(keyStatus(recovered)).toBe('working');
    const c=tracker.project(recovered,scan(NOW+7000,[row('unknown')]),NOW+7000);
    expect(keyStatus(c)).toBe('working');
    expect(keyStatus(tracker.project(c,scan(NOW+22_000,[row('unknown')]),NOW+22_000)))
      .toBe('unknown');
  });
});
