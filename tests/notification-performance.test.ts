import { describe, expect, it } from 'vitest';
import { estimateNotificationLag, NotificationPerformance } from '../src/shared/notification-performance';
import type { MonitorAlert, ScanResponse, SessionRecord } from '../src/shared/types';

const NOW=Date.parse('2026-10-15T03:00:00Z');
const EVENT=NOW-11_000;
// A remote clock is nine minutes ahead; the event and mtime share that clock.
const SOURCE_EVENT=EVENT+9*60_000;
const token=new Date(SOURCE_EVENT).toISOString()+'|turn-a';
const remote: SessionRecord={
  id:'turn',key:'ssh:remote:turn',sourceId:'ssh:remote',sourceLabel:'Remote',
  workspace:'/repo',title:'Test',status:'interrupted',statusReason:'aborted',
  updatedAt:SOURCE_EVENT+5000,ageAtSourceMs:6000,startedAt:null,
  interruptedToken:token,
};
const scan: ScanResponse={scannedAt:NOW+90_000,sources:[{
  id:'ssh:remote',kind:'ssh',label:'Remote',capturedAt:NOW, error:null,sessions:[remote],
}]};
const alert: MonitorAlert={
  id:JSON.stringify([remote.key,'interrupted',token]),
  sessionKey:remote.key,sessionId:remote.id,kind:'interrupted',title:'Test',
  sourceLabel:'Remote',workspace:null,at:NOW+1000,read:false,
  statusReason:'aborted',questionText:null,
};

describe('bounded notification discovery delay indicators', () => {
  it('estimates event-to-notification delay without depending on remote clock skew', () => {
    expect(estimateNotificationLag(alert,scan,NOW+1000)).toBe(12_000);
    expect(estimateNotificationLag(alert,{...scan,scannedAt:NOW+600_000},NOW+1000))
      .toBe(12_000);
  });

  it('drops native completions, malformed ids, stale sources, and invalid age', () => {
    expect(estimateNotificationLag({...alert,id:'bad'},scan,NOW+1000)).toBeNull();
    expect(estimateNotificationLag({...alert,id:JSON.stringify([
      remote.key,'interrupted','desktop:turn-a'])},scan,NOW+1000)).toBeNull();
    expect(estimateNotificationLag(alert,{...scan,sources:[{...scan.sources[0]!,error:'offline'}]},
      NOW+1000)).toBeNull();
    expect(estimateNotificationLag(alert,scan,NOW+20*60_000)).toBeNull();
  });

  it('keeps a bounded rolling P50/P95/max distribution, never prompt contents', () => {
    const tracker=new NotificationPerformance();
    tracker.observe([alert],scan,NOW+1000);
    tracker.observe([alert],scan,NOW+2000);
    expect(tracker.snapshot()).toEqual({
      samples:2,p50Ms:12_000,p95Ms:13_000,maxMs:13_000,
    });
  });
});
