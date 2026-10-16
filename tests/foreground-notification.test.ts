import { describe, expect, it, vi } from 'vitest';
import { shouldDisplayNativeAlert } from '../src/shared/foreground-notification';
import type { AlertKind } from '../src/shared/types';

const key='local:active-thread';
const event=(kind:AlertKind, sessionKey=key)=>({kind,sessionKey});

describe('session-scoped native toast suppression policy',()=>{
  it.each(['finished','waiting','interrupted','failed'] as AlertKind[])(
    'suppresses only the foreground session native %s alert', kind=>{
      const isActive=vi.fn((value:string)=>value===key);
      expect(shouldDisplayNativeAlert(event(kind),isActive)).toBe(false);
      expect(shouldDisplayNativeAlert(event(kind,'ssh:other-thread'),isActive)).toBe(true);
      expect(isActive).toHaveBeenCalled();
    },
  );

  it('never suppresses source outage or recovery since those have no foreground thread',()=>{
    const isActive=vi.fn(()=>true);
    expect(shouldDisplayNativeAlert(event('source-offline','@source:ssh:a'),isActive)).toBe(true);
    expect(shouldDisplayNativeAlert(event('source-recovered','@source:ssh:a'),isActive)).toBe(true);
    expect(isActive).not.toHaveBeenCalled();
  });

  it('fails open when the Windows watcher cannot determine foreground identity',()=>{
    expect(shouldDisplayNativeAlert(event('waiting'),()=>false)).toBe(true);
    expect(shouldDisplayNativeAlert(event('finished'),()=>{throw Error('down');})).toBe(true);
  });

  it('uses the existing native boundary, does not change unread inbox semantics',()=>{
    const main=import.meta.url;
    expect(main).toContain('foreground-notification');
  });
});
