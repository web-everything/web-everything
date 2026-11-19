// @vitest-environment node
// A HEAD symlink the client changed in its index (deleted, retargeted or turned
// into a file) cannot be told apart from an untouched one by the runner: the
// manifest carries no link evidence. The client owns that evidence, so it refuses
// remote execution (local fallback) before any manifest reaches the runner.
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {buildManifest} from '../remote-exec.mjs';

let cwd,head;
const exec=async ({file,args,cwd,input})=>{
  const result=spawnSync(file,args,{cwd,input,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  return {code:result.status,stdout:result.stdout,stderr:result.stderr};
};
const git=async(...args)=>{const r=await exec({file:'git',args,cwd});if(r.code!==0)throw new Error('Fixture git failed: '+args.join(' '));return r.stdout.toString().trim();};
const write=async(name,data)=>{await fs.mkdir(join(cwd,name,'..'),{recursive:true});await fs.writeFile(join(cwd,name),data);};
const commit=async()=>{await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');await git('update-ref','refs/remotes/origin/main','HEAD');};
beforeEach(async()=>{
  cwd=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-head-link-')));
  await git('init','-q');
  await fs.writeFile(join(cwd,'package-lock.json'),'{"lockfileVersion":3,"packages":{}}\n');
  await write('src/copied.md','copied');await write('new-src/copied.md','copied');
  await fs.symlink('src',join(cwd,'alias'));
  await git('add','.');await commit();
  head=await git('rev-parse','HEAD');
});
afterEach(async()=>fs.rm(cwd,{recursive:true,force:true}));

describe('HEAD symlink changed in the client index (remote refusal)',()=>{
  it('ships when every HEAD symlink is unchanged',async()=>{
    const manifest=await buildManifest({cwd,exec,head});
    expect(manifest.entries.map(e=>e.path.toString())).toContain('alias/copied.md');
  });
  it('refuses a staged deletion replaced by an untracked real directory with matching bytes',async()=>{
    await git('rm','-q','--cached','alias');await fs.rm(join(cwd,'alias'));
    await write('alias/copied.md','copied');
    await expect(buildManifest({cwd,exec,head})).rejects.toMatchObject({code:'head-symlink-changed'});
  });
  it('refuses a link retargeted and staged without a commit',async()=>{
    await fs.rm(join(cwd,'alias'));await fs.symlink('new-src',join(cwd,'alias'));await git('add','alias');
    await expect(buildManifest({cwd,exec,head})).rejects.toMatchObject({code:'head-symlink-changed'});
  });
  it('refuses a link replaced by a regular file (mode change)',async()=>{
    await fs.rm(join(cwd,'alias'));await write('alias','plain');await git('add','alias');
    await expect(buildManifest({cwd,exec,head})).rejects.toMatchObject({code:'head-symlink-changed'});
  });
  it('refuses a link replaced by a tracked real directory',async()=>{
    await git('rm','-q','--cached','alias');await fs.rm(join(cwd,'alias'));
    await write('alias/new.md','new');await git('add','alias/new.md');
    await expect(buildManifest({cwd,exec,head})).rejects.toMatchObject({code:'head-symlink-changed'});
  });
  it('does not inspect HEAD links when no logical head is pinned (non-Git runs are unchanged)',async()=>{
    await git('rm','-q','--cached','alias');await fs.rm(join(cwd,'alias'));await write('alias/copied.md','copied');
    await expect(buildManifest({cwd,exec})).resolves.toBeTruthy();
  });
});
