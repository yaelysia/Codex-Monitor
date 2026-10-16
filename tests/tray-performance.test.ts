import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorState, FloatingWindowState } from '../src/shared/types';
import type { MainWindowController } from '../electron/main-window';
import type { FloatingWindowController } from '../electron/floating';
import type { MonitorService } from '../electron/monitor-service';
import type { ResidentStore } from '../electron/resident-store';

const fake = vi.hoisted(() => ({
  trays: [] as Array<{tooltips: string[]; menus: unknown[]; destroyed: boolean}>,
  built: [] as unknown[],
}));
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({}) },
  Menu: { buildFromTemplate: (items: unknown) => {
    fake.built.push(items);
    return {items};
  }},
  Tray: class {
    tooltips: string[] = [];
    menus: unknown[] = [];
    destroyed = false;
    constructor() { fake.trays.push(this); }
    on() {}
    setToolTip(text: string) { this.tooltips.push(text); }
    setContextMenu(menu: unknown) { this.menus.push(menu); }
    destroy() { this.destroyed = true; }
  },
}));
import { TrayController } from '../electron/tray';

function fixture() {
  let muted = false;
  let unread = 0;
  let working = 0;
  let opacity = 1;
  let floatingVisible = true;
  let keepRunning = true;
  const monitor = {
    state: (): MonitorState => ({
      muted, alerts: Array.from({length:unread}, (_,i) => ({
        id:String(i),kind:'finished' as const,sessionKey:'local:'+i,
        sessionId:String(i), title:'Test',sourceLabel:'Windows',
        workspace:null,at:1000,read:false,statusReason:'finished',
      })),
      scan:{scannedAt:1000,sources:[{id:'local',label:'Windows',kind:'local' as const,
        error:null,sessions:Array.from({length:working}, (_,i) => ({
          key:'local:'+i,id:String(i),sourceId:'local',sourceLabel:'Windows',
          title:'Test',workspace:null,status:'working' as const,
          statusReason:'working',updatedAt:1000,startedAt:null,
        }))}]},
    }),
    setMuted: (enabled: boolean) => { muted = enabled; },
  } as unknown as MonitorService;
  const dock = {
    state: (): FloatingWindowState => ({
      visible:floatingVisible,expanded:false,side:'right',opacity,
      appearance:'moonsea',compactSize:'micro',
    }),
    setVisible: (value:boolean) => {floatingVisible=value;},
    setOpacity: (value:number) => {opacity=value;},
  } as unknown as FloatingWindowController;
  const resident={
    snapshot: () => ({preferences:{keepRunningOnClose:keepRunning,launchAtLogin:false}}),
    updatePreferences: (prefs:{keepRunningOnClose:boolean})=>{keepRunning=prefs.keepRunningOnClose;},
  } as unknown as ResidentStore;
  const main={show:vi.fn()} as unknown as MainWindowController;
  const controller=new TrayController(main,dock,monitor,resident,vi.fn());
  return {
    controller, mute:(v:boolean)=>{muted=v;}, unread:(v:number)=>{unread=v;},
    working:(v:number)=>{working=v;}, opacity:(v:number)=>{opacity=v;},
    visible:(v:boolean)=>{floatingVisible=v;}, resident:(v:boolean)=>{keepRunning=v;},
  };
}
beforeEach(() => {fake.trays=[];fake.built=[];});

describe('resident tray native-work avoidance', () => {
  it('creates one native menu on startup and reuses it across status/alert broadcasts', () => {
    const ctx=fixture();
    ctx.controller.start();
    const tray=fake.trays[0]!;
    expect(fake.built).toHaveLength(1);
    expect(tray.menus).toHaveLength(1);
    expect(tray.tooltips).toHaveLength(2);
    for(let i=0;i<125;i++) ctx.controller.refresh();
    expect(tray.menus).toHaveLength(1);
    expect(tray.tooltips).toHaveLength(2);
    ctx.unread(5);
    ctx.working(3);
    ctx.controller.refresh();
    expect(tray.menus).toHaveLength(1);
    expect(tray.tooltips.at(-1)).toContain('可能执行中 3 · 未读 5');
    const count=tray.tooltips.length;
    ctx.controller.refresh();
    expect(tray.tooltips).toHaveLength(count);
    ctx.controller.destroy();
    expect(tray.destroyed).toBe(true);
  });

  it('rebuilds only when a menu option changes, including dock opacity',()=>{
    const ctx=fixture();
    ctx.controller.start();
    const tray=fake.trays[0]!;
    ctx.mute(true);
    ctx.controller.refresh();
    expect(tray.menus).toHaveLength(2);
    ctx.controller.refresh();
    expect(tray.menus).toHaveLength(2);
    ctx.opacity(.7);
    ctx.controller.refresh();
    expect(tray.menus).toHaveLength(3);
    ctx.visible(false);
    ctx.controller.refresh();
    expect(tray.menus).toHaveLength(4);
    ctx.resident(false);
    ctx.controller.refresh();
    expect(tray.menus).toHaveLength(5);
    ctx.controller.destroy();
  });
});
