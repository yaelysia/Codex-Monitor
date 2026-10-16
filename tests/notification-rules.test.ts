import { describe, expect, it } from 'vitest';
import { AlertTracker } from '../src/shared/alert-tracker';
import { DEFAULT_NOTIFICATION_KINDS, normalizeNotificationKinds,
  NOTIFICATION_KIND_KEYS, isNotificationKind } from '../src/shared/notification-rules';
import type { SessionRecord, ScanResponse, SourceResult } from '../src/shared/types';

const NOW = 1_800_000_000_000;
const make = (status: SessionRecord['status'], at: number,
  other: Partial<SessionRecord> = {}): SessionRecord => ({
  key: 'local:session', id: 'session', sourceId: 'local',
  sourceLabel: 'Windows', title: 'Session',
  workspace: null, status, statusReason: status,
  updatedAt: at, ageAtSourceMs: 1000, byteSize: 100,
  startedAt: null, ...other,
});
const scan = (at: number, row: SessionRecord, error: string | null = null): ScanResponse =>
  ({ scannedAt: at, sources: [{ id:'local', label:'Windows', kind:'local',
    sessions: error ? [] : [row], error }] });
const sourceScan = (at: number, error: string | null): ScanResponse => ({
  scannedAt: at, sources: [{ id:'ssh:one', label:'Server', kind:'ssh',
    error, sessions: [] }],
});

describe('independent notification category settings', () => {
  it('defaults all six supported kinds to on and rejects unknown/invalid values', () => {
    expect(NOTIFICATION_KIND_KEYS).toHaveLength(6);
    expect(Object.keys(DEFAULT_NOTIFICATION_KINDS).sort()).toEqual([...NOTIFICATION_KIND_KEYS].sort());
    expect(Object.values(DEFAULT_NOTIFICATION_KINDS).every(Boolean)).toBe(true);
    expect(normalizeNotificationKinds({finished:false,waiting:'false',custom:false})).toEqual({
      ...DEFAULT_NOTIFICATION_KINDS,finished:false,
    });
    expect(normalizeNotificationKinds(null)).toEqual(DEFAULT_NOTIFICATION_KINDS);
    expect(isNotificationKind('source-recovered')).toBe(true);
    expect(isNotificationKind('__proto__')).toBe(false);
  });

  it.each(['waiting','finished','failed','interrupted'] as const)(
    'marks disabled %s events read without losing event history', kind => {
      const t=new AlertTracker();
      t.observe(scan(NOW,make('working',NOW)),NOW);
      t.setNotificationKindEnabled(kind,false);
      const stamp=new Date(NOW+1000).toISOString()+'|turn-2';
      const row=make(kind==='waiting'?'waiting':kind,NOW+1000,{
        byteSize:250,ageAtSourceMs:0,
        ...(kind==='finished'?{finishedToken:stamp}:{}),
        ...(kind==='failed'?{failedToken:stamp,failureTokens:[stamp]}:{}),
        ...(kind==='interrupted'?{interruptedToken:stamp,interruptionTokens:[stamp]}:{}),
        ...(kind==='waiting'?{waitingToken:'blocking:ask-2',pendingQuestionToken:'blocking:ask-2'}:{}),
      });
      const emitted=t.observe(scan(NOW+2000,row),NOW+2000);
      expect(emitted).toMatchObject([{kind,read:true}]);
      expect(t.getAlerts()).toMatchObject([{kind,read:true}]);
      expect(t.observe(scan(NOW+3000,row),NOW+3000)).toEqual([]);
      t.setNotificationKindEnabled(kind,true);
      expect(t.getAlerts()[0]?.read).toBe(true);
    },
  );

  it('disables source outage and recovery independently without disabling health tracking', () => {
    const t=new AlertTracker();
    t.setNotificationKindEnabled('source-offline',false);
    t.observe(sourceScan(NOW,null),NOW);
    t.observe(sourceScan(NOW+1000,'SSH timeout'),NOW+1000);
    const offline=t.observe(sourceScan(NOW+32_000,'SSH timeout'),NOW+32_000);
    expect(offline).toMatchObject([{kind:'source-offline',read:true}]);
    expect(t.getAlerts()[0]?.read).toBe(true);
    // The outcome still counts as a notified incident internally so recovery
    // gets its own event, controlled by the independent recovery preference.
    const recovered=t.observe(sourceScan(NOW+33_000,null),NOW+33_000);
    expect(recovered).toMatchObject([{kind:'source-recovered',read:false}]);
    t.setNotificationKindEnabled('source-recovered',false);
    t.observe(sourceScan(NOW+34_000,'SSH timeout'),NOW+34_000);
    t.observe(sourceScan(NOW+65_000,'SSH timeout'),NOW+65_000);
    expect(t.observe(sourceScan(NOW+66_000,null),NOW+66_000))
      .toMatchObject([{kind:'source-recovered',read:true}]);
    expect(t.getAlerts()).toHaveLength(4);
  });

  it('marks already-unread events read when disabled, never revives old alerts, and keeps global mute separate', () => {
    const t=new AlertTracker();
    t.observe(scan(NOW,make('working',NOW)),NOW);
    const first=t.observe(scan(NOW+2000,make('finished',NOW+1000,{
      byteSize:200,finishedToken:'end|1',
    })),NOW+2000);
    expect(first).toMatchObject([{kind:'finished',read:false}]);
    t.setNotificationKindEnabled('finished',false);
    expect(t.state(null).alerts[0]?.read).toBe(true);
    expect(t.getNotificationKinds().finished).toBe(false);
    t.setMuted(true);
    t.setNotificationKindEnabled('finished',true);
    expect(t.getMuted()).toBe(true);
    expect(t.state(null).alerts[0]?.read).toBe(true);
    // The same turn is not emitted again simply because its kind re-enabled.
    expect(t.observe(scan(NOW+3000,make('finished',NOW+1000,{
      byteSize:200,finishedToken:'end|1',
    })),NOW+3000)).toEqual([]);
    const second=t.observe(scan(NOW+4000,make('finished',NOW+3500,{
      byteSize:250,finishedToken:'end|2',
    })),NOW+4000);
    expect(second).toMatchObject([{kind:'finished',read:false}]);
  });

  it('filters first-party Desktop native completion through the same rule', () => {
    const t=new AlertTracker();
    const thread='019a21b0-aaaa-7ccc-8ddd-111122223333';
    const turn='019a21b0-aaaa-7ccc-8ddd-999922223333';
    const row=make('working',NOW,{id:thread,key:'local:'+thread,clientKind:'desktop'});
    const current=scan(NOW,row);
    const event={threadId:thread,turnId:turn,type:'turn-displayed-complete' as const,at:NOW+500};
    t.setNotificationKindEnabled('finished',false);
    expect(t.observeDesktopCompletions(current,[event],NOW-1000,NOW+800))
      .toMatchObject([{kind:'finished',read:true}]);
    t.setNotificationKindEnabled('finished',true);
    expect(t.observeDesktopCompletions(current,[event],NOW-1000,NOW+900)).toEqual([]);
  });
});
