import { describe, expect, it } from 'vitest';
import { keepStableScan, nextScanRevision } from '../src/shared/monitor-render-state';
import type { MonitorState, ScanResponse } from '../src/shared/types';

const scan: ScanResponse={scannedAt:1000,sources:[{
  id:'local',label:'Windows',kind:'local',error:null,
  sessions:[{id:'x',key:'local:x',sourceId:'local',sourceLabel:'Windows',
    workspace:null,title:null,status:'working',statusReason:'working',
    updatedAt:1000,startedAt:null}],
}]};
const state=(scanRevision: number, data: ScanResponse = scan): MonitorState =>
  ({scan:data,scanRevision,alerts:[],muted:false});

describe('IPC session tree identity retention',()=>{
  it('preserves heavy scan references for alert acknowledgement, mute and preference-only changes',()=>{
    const previous=state(4);
    const incoming={...state(4,{...scan,sources:[...scan.sources]}),muted:true};
    const result=keepStableScan(previous,incoming);
    expect(result.scan).toBe(previous.scan);
    expect(result.muted).toBe(true);
    expect(nextScanRevision(4,incoming)).toBeNull();
    expect(nextScanRevision(null,incoming)).toBe(4);
  });

  it('accepts a newer native projection or source refresh while discarding late IPC snapshots',()=>{
    const prior=state(4);
    const native={...state(5,{...scan,scannedAt:1000,sources:scan.sources.map(s=>({
      ...s,sessions:s.sessions.map(session=>({...session,status:'finished' as const}))}))})};
    expect(keepStableScan(prior,native).scan).toBe(native.scan);
    expect(nextScanRevision(4,native)).toBe(5);
    expect(keepStableScan(native,state(4))).toBe(native);
    expect(nextScanRevision(5,state(4))).toBeNull();
  });

  it('falls back safely if an older mock/client does not provide a revision',()=>{
    const older:MonitorState={scan,alerts:[],muted:false};
    const another:MonitorState={...older,scan:{...scan}};
    expect(keepStableScan(older,another).scan).toBe(another.scan);
    expect(nextScanRevision(null,another)).toBe(0);
  });
});
