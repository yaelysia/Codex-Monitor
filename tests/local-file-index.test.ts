import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalFileIndex, INDEX_REDISCOVERY_MS } from '../electron/local-file-index';

const directories: string[] = [];
afterEach(async () => {
  for(const directory of directories.splice(0)) await fs.rm(directory,{recursive:true,force:true});
});

async function fixture() {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'monitor-file-index-'));
  directories.push(home);
  const root=path.join(home,'sessions');
  const day=path.join(root,'2026','10','15');
  await fs.mkdir(day,{recursive:true});
  return {home,root,day};
}
const NOW=1_800_000_000_000;

describe('bounded event-assisted local file discovery', () => {
  it('does not restat all historical files for each confirmed JSONL change', async () => {
    const {root,day}=await fixture();
    for(let i=0;i<90;i++){
      const file=path.join(day,'rollout-'+i+'.jsonl');
      await fs.writeFile(file,'{}');
      await fs.utimes(file,new Date(NOW-100_000+i),new Date(NOW-100_000+i));
    }
    const index=new LocalFileIndex();
    expect(await index.candidates(root,NOW,false)).toHaveLength(90);
    expect(index.diagnostics()).toMatchObject({mode:'full',statCalls:90,indexedFiles:90});
    expect(await index.candidates(root,NOW+1000,true)).toHaveLength(90);
    expect(index.diagnostics()).toMatchObject({mode:'incremental',statCalls:0});

    const file=path.join(day,'rollout-0.jsonl');
    await fs.utimes(file,new Date(NOW),new Date(NOW));
    index.note(root,'2026\\10\\15\\rollout-0.jsonl');
    const latest=await index.candidates(root,NOW+2000,true);
    expect(latest[0]?.file).toBe(file);
    expect(index.diagnostics()).toMatchObject({mode:'incremental',statCalls:1,changedPaths:1});
  });

  it('finds a new file via event hint and rediscovers unreported files periodically', async () => {
    const {root,day}=await fixture();
    const index=new LocalFileIndex();
    await index.candidates(root,NOW,false);
    const first=path.join(day,'rollout-new.jsonl');
    await fs.writeFile(first,'{}');
    index.note(root,'2026/10/15/rollout-new.jsonl');
    expect((await index.candidates(root,NOW+1000,true)).map(item=>item.file))
      .toContain(first);
    const missed=path.join(day,'rollout-missed.jsonl');
    await fs.writeFile(missed,'{}');
    expect(index.diagnostics().mode).toBe('incremental');
    expect((await index.candidates(root,NOW+2000,true)).map(x=>x.file))
      .not.toContain(missed);
    expect((await index.candidates(root,NOW+INDEX_REDISCOVERY_MS+1,true)).map(x=>x.file))
      .toContain(missed);
    expect(index.diagnostics().mode).toBe('full');
  });

  it('does not follow event hints through a symlinked date directory', async () => {
    if (process.platform === 'win32') return; // Creating directory links needs privileges.
    const {home,root}=await fixture();
    const index=new LocalFileIndex();
    await index.candidates(root,NOW,false);
    const outside=path.join(home,'outside');
    await fs.mkdir(outside,{recursive:true});
    await fs.writeFile(path.join(outside,'rollout-leak.jsonl'),'{}');
    await fs.mkdir(path.join(root,'2026','10'),{recursive:true});
    await fs.symlink(outside,path.join(root,'2026','10','16'),'dir');
    index.note(root,'2026/10/16/rollout-leak.jsonl');
    expect(await index.candidates(root,NOW+1000,true)).toEqual([]);
  });

  it('unknown directory and untrusted paths invalidate discovery rather than accessing paths', async () => {
    const {root,day}=await fixture();
    const index=new LocalFileIndex();
    await index.candidates(root,NOW,false);
    index.note(root,'../../other.jsonl');
    expect(index.diagnostics().mode).toBe('full');
    await index.candidates(root,NOW+1000,true);
    expect(index.diagnostics().mode).toBe('full');
    const file=path.join(day,'rollout-in-new-day.jsonl');
    await fs.writeFile(file,'{}');
    index.note(root,'2026/10/16');
    expect((await index.candidates(root,NOW+2000,true)).map(x=>x.file))
      .toContain(file);
  });
});
