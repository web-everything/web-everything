// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {buildManifest,buildDeltaManifest} from '../remote-exec.mjs';
import {manifestWire,digestManifest,parseGitStatus} from '../forge-exec-manifest.mjs';
let cwd,base;
const exec=async ({file,args,cwd,input})=>{
  const result=spawnSync(file,args,{cwd,input,maxBuffer:4*1024*1024});
  if(result.error)throw result.error;
  return {code:result.status,stdout:result.stdout};
};
async function git(args) {
  const result=await exec({file:'git',args,cwd});
  if(result.code!==0)throw new Error('Fixture git failed');
  return result.stdout;
}
const commit=()=>git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
const write=(name,data)=>fs.writeFile(join(cwd,name),data);
const readSpy=()=>{const readFile=vi.fn(path=>fs.readFile(path));return {fs:{...fs,readFile},readFile};};
const readNames=spy=>spy.mock.calls.map(([path])=>Buffer.from(path).subarray(Buffer.byteLength(cwd)+1).toString()).sort();
beforeEach(async()=>{
  cwd=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-fast-manifest-')));
  await git(['init','-q']);
  await write('keep.txt','keep');await write('edit.txt','edit');await write('remove.txt','remove');
  await git(['add','.']);await commit();
  const manifest=await buildManifest({cwd,exec});
  base={sha:(await git(['rev-parse','HEAD'])).toString().trim(),manifest:manifestWire(manifest),manifestDigest:manifest.manifestDigest};
});
afterEach(async()=>fs.rm(cwd,{recursive:true,force:true}));
async function compare(options={}) {
  const fast=await buildDeltaManifest({cwd,exec,base,...options});
  const full=await buildManifest({cwd,exec});
  expect(fast.entries).toEqual(full.entries);
  expect(fast.excluded).toEqual(full.excluded);
  expect(manifestWire(fast)).toEqual(manifestWire(full));
  expect(fast.manifestDigest).toBe(full.manifestDigest);
  expect(digestManifest(manifestWire(fast))).toBe(full.manifestDigest);
  return fast;
}
describe('fast Git manifest',()=>{
  it('bounds concurrent metadata capture and drains it before diff/status/flags',async()=>{
    for(let i=0;i<40;i++)await write(`leaf-${i}.txt`,'leaf');
    await git(['add','.']);await commit();
    const full=await buildManifest({cwd,exec});
    const warm={sha:(await git(['rev-parse','HEAD'])).toString().trim(),manifest:manifestWire(full),manifestDigest:full.manifestDigest};
    let active=0,maximum=0,captures=0,evidence=false;
    const observedFs={...fs,lstat:async path=>{
      if(evidence)return fs.lstat(path);
      active++;maximum=Math.max(maximum,active);
      try {await new Promise(resolve=>setImmediate(resolve));return await fs.lstat(path);}
      finally {active--;captures++;}
    }};
    const observedExec=async call=>{
      if(['diff','status','check-attr'].includes(call.args[0])||call.args.includes('-v')) {
        expect(active).toBe(0);expect(captures).toBe(full.entries.length);evidence=true;
      }
      return exec(call);
    };
    const fast=await buildDeltaManifest({cwd,exec:observedExec,fs:observedFs,base:warm});
    expect(maximum).toBeGreaterThan(1);expect(maximum).toBeLessThanOrEqual(16);
    expect(fast.manifestMode).toBe('git-delta');expect(manifestWire(fast)).toEqual(manifestWire(full));
  });
  it('drains a failed lstat pass and hashes everything without partial reuse',async()=>{
    let active=0,failed=false;
    const observedFs={...fs,lstat:async path=>{
      active++;
      try {
        await new Promise(resolve=>setImmediate(resolve));
        if(!failed){failed=true;throw Object.assign(new Error('unreadable'),{code:'EACCES'});}
        return await fs.lstat(path);
      } finally {active--;}
    }};
    const observedExec=async call=>{
      if(call.args.includes('-i'))expect(active).toBe(0);
      return exec(call);
    };
    const fast=await compare({fs:observedFs,exec:observedExec});
    expect(fast.manifestMode).toBe('full-scan');expect(active).toBe(0);
  });
  it('reads only committed, staged, unstaged and untracked changes, matching full entries, wire and digest',async()=>{
    await write('edit.txt','committed');await git(['add','.']);await commit();
    await write('staged.txt','staged');await git(['add','staged.txt']);
    await write('new.txt','new');await fs.rm(join(cwd,'remove.txt'));
    const spy=readSpy(),fast=await compare({fs:spy.fs});
    expect(fast.manifestMode).toBe('git-delta');
    expect(readNames(spy.readFile)).toEqual(['edit.txt','new.txt','staged.txt']);
    expect(fast.deletions).toEqual([Buffer.from('remove.txt')]);
  });
  it.each(['injected','batch'])('hashes a dirty warm snapshot followed by a same-size clean reversion (%s Git reader)',async reader=>{
    await write('keep.txt','dirt');
    const dirty=await buildManifest({cwd,exec});
    const dirtyBase={...base,manifest:manifestWire(dirty),manifestDigest:dirty.manifestDigest};
    await git(['checkout','--','keep.txt']);
    expect(await git(['status','--porcelain=v1','-z'])).toHaveLength(0);
    const spy=readSpy();
    const fast=await compare({base:dirtyBase,fs:spy.fs,...(reader==='batch'?{exec:undefined}:{})});
    expect(fast.manifestMode).toBe('git-delta');
    expect(readNames(spy.readFile)).toEqual(['keep.txt']);
    expect(fast.deltaPaths).toEqual([Buffer.from('keep.txt')]);
  });
  it.each(['failed','oversized','truncated','wrong bytes'])('falls back to full scan when blob-content evidence is %s',async fault=>{
    const broken=async call=>{
      if(call.args[0]==='cat-file'&&call.args[1]==='blob')return {
        code:fault==='failed'?1:0,
        stdout:Buffer.alloc(fault==='oversized'?4*1024*1024+1:fault==='truncated'?0:4),
      };
      return exec(call);
    };
    const spy=readSpy(),fast=await compare({exec:broken,fs:spy.fs});
    expect(fast.manifestMode).toBe('full-scan');
    expect(fast.manifestReason).toBeTruthy();
    expect(readNames(spy.readFile)).toEqual(['edit.txt','keep.txt','remove.txt']);
  });
  it('hashes leaves above the blob-reader size limit normally',async()=>{
    await write('large.txt',Buffer.alloc(4*1024*1024+1,97));await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    const largeBase={sha:(await git(['rev-parse','HEAD'])).toString().trim(),manifest:manifestWire(manifest),manifestDigest:manifest.manifestDigest};
    const spy=readSpy(),fast=await compare({base:largeBase,fs:spy.fs,exec:undefined});
    expect(fast.manifestMode).toBe('git-delta');
    expect(readNames(spy.readFile)).toEqual(['large.txt']);
  });
  it('includes both rename/copy paths, including opaque byte paths',()=>{
    const opaque=Buffer.from([0xff,46,116,120,116]);
    const bytes=Buffer.concat([Buffer.from('R  dest.txt\0source.txt\0 C copy.txt\0'),opaque,Buffer.from('\0?? new.txt\0')]);
    expect(parseGitStatus(bytes)).toEqual([Buffer.from('dest.txt'),Buffer.from('source.txt'),Buffer.from('copy.txt'),opaque,Buffer.from('new.txt')]);
    expect(()=>parseGitStatus(Buffer.from('R  dest.txt\0'))).toThrow();
  });
  it('handles staged renames and byte paths in the live Git inventory',async()=>{
    await git(['mv','edit.txt','renamed.txt']);
    const path=Buffer.concat([Buffer.from(cwd+'/'),Buffer.from('space café.txt')]);
    await fs.writeFile(path,'opaque');
    const fast=await compare();expect(fast.manifestMode).toBe('git-delta');
    expect(fast.deltaPaths).toContainEqual(Buffer.from('renamed.txt'));
    expect(fast.entries.map(entry=>entry.path)).toContainEqual(Buffer.from('space café.txt'));
  });
  it.each(['bad','a'.repeat(40)])('reports full-scan for unknown/unparseable base %s',async sha=>{
    const spy=readSpy(),fast=await compare({base:{...base,sha},fs:spy.fs});
    expect(fast.manifestMode).toBe('full-scan');expect(fast.manifestReason).toBeTruthy();
    expect(readNames(spy.readFile)).toEqual(['edit.txt','keep.txt','remove.txt']);
  });
  it.each(['diff','status','check-attr','ls-files flags','oversized','truncated','throw'])('falls back without partial reuse on %s evidence',async fault=>{
    const broken=async call=>{
      const command=fault==='ls-files flags'?'ls-files':fault;
      if(call.args[0]===command && (command!=='ls-files'||call.args.includes('-v')))return {code:1,stdout:Buffer.alloc(0)};
      if(call.args[0]==='status') {
        if(fault==='throw')throw new Error('process failed');
        if(fault==='oversized')return {code:0,stdout:Buffer.alloc(4*1024*1024+1)};
        if(fault==='truncated')return {code:0,stdout:Buffer.from(' M edit.txt')};
      }
      return exec(call);
    };
    const spy=readSpy(),fast=await compare({exec:broken,fs:spy.fs});
    expect(fast.manifestMode).toBe('full-scan');expect(fast.manifestReason).toBeTruthy();
    expect(readNames(spy.readFile)).toHaveLength(3);
  });
  it.each(['size','mode','symlink'])('retains fresh %s checks even when status hides the path',async fault=>{
    if(fault==='size')await write('keep.txt','longer content');
    if(fault==='mode')await fs.chmod(join(cwd,'keep.txt'),0o755);
    if(fault==='symlink'){await fs.rm(join(cwd,'keep.txt'));await fs.symlink('edit.txt',join(cwd,'keep.txt'));}
    const hidden=call=>call.args[0]==='status'?Promise.resolve({code:0,stdout:Buffer.alloc(0)}):exec(call);
    if(fault==='symlink')await expect(buildDeltaManifest({cwd,exec:hidden,base})).rejects.toThrow('Unsafe inventory component');
    else {const spy=readSpy();await compare({exec:hidden,fs:spy.fs});expect(readNames(spy.readFile)).toEqual(['keep.txt']);}
  });
  it.each(['filter','filter named unset','assume-unchanged','skip-worktree','skip-worktree + assume-unchanged'])('hashes same-size Git-clean changes hidden by %s',async kind=>{
    if(kind==='filter'||kind==='filter named unset') {
      const driver=kind==='filter'?'fixture':'unset';
      await write('.gitattributes',`keep.txt filter=${driver}\n`);
      await git(['config',`filter.${driver}.clean`,'printf keep']);
      await git(['add','.']);await commit();
    } else {
      if(kind.includes('skip-worktree'))await git(['update-index','--skip-worktree','keep.txt']);
      if(kind.includes('assume-unchanged'))await git(['update-index','--assume-unchanged','keep.txt']);
      const flag=kind==='skip-worktree'?'S':kind==='assume-unchanged'?'h':'s';
      expect((await git(['ls-files','-f','-v','--','keep.txt'])).toString()).toBe(`${flag} keep.txt\n`);
    }
    await write('keep.txt','diff');
    expect(await git(['diff','--name-only'])).toHaveLength(0);
    const spy=readSpy();await compare({fs:spy.fs});
    expect(readNames(spy.readFile)).toContain('keep.txt');
  });
  it.each([
    ['filter','filter=fixture'],
    ['working-tree-encoding','working-tree-encoding=UTF-8'],
    ['working-tree-encoding','working-tree-encoding=UTF-16LE'],
    ['ident','ident'],
    ['text','text'],
    ['eol','eol=crlf'],
  ])('hashes Git-clean %s leaves (%s) and matches full hashing',async(attribute,rule)=>{
    await write('.gitattributes',`keep.txt ${rule}\n`);
    if(attribute==='filter')await git(['config','filter.fixture.clean','cat']);
    if(rule==='working-tree-encoding=UTF-16LE')await write('keep.txt',Buffer.from('keep','utf16le'));
    await git(['add','.']);await commit();
    const manifest=await buildManifest({cwd,exec});
    const cleanBase={sha:(await git(['rev-parse','HEAD'])).toString().trim(),manifest:manifestWire(manifest),manifestDigest:manifest.manifestDigest};
    expect(await git(['status','--porcelain=v1','-z'])).toHaveLength(0);
    expect((await git(['check-attr','--all','--','keep.txt'])).toString()).toContain(`: ${attribute}:`);
    const spy=readSpy(),fast=await compare({base:cleanBase,fs:spy.fs});
    expect(fast.manifestMode).toBe('git-delta');
    expect(readNames(spy.readFile)).toEqual(['keep.txt']);
  });
  it('full-scans a same-size edit hidden by unsafe stat config and restored mtime',async()=>{
    await git(['config','core.trustctime','false']);
    await git(['config','core.checkStat','minimal']);
    const path=join(cwd,'keep.txt');
    // Whole seconds survive utimes exactly and predate the index's racy window.
    await fs.utimes(path,1000000000,1000000000);
    await git(['update-index','--refresh']);
    const stat=await fs.stat(path);
    await write('keep.txt','diff');await fs.utimes(path,stat.atime,stat.mtime);
    expect(await git(['status','--porcelain=v1','-z'])).toHaveLength(0);
    const spy=readSpy(),fast=await compare({fs:spy.fs});
    expect(fast.manifestMode).toBe('full-scan');
    expect(fast.manifestReason).toContain('unsafe stat config');
    expect(fast.manifestDigest).not.toBe(base.manifestDigest);
    expect(readNames(spy.readFile)).toEqual(['edit.txt','keep.txt','remove.txt']);
  });
  it.each([
    ['core.trustctime','false'],['core.trustctime','0'],['core.checkStat','minimal'],
    ['core.fsmonitor','true'],['core.fsmonitor','hooks/fsmonitor'],
  ])('full-scans unsafe stat config %s=%s',async(key,value)=>{
    await git(['config',key,value]);
    const fast=await compare();
    expect(fast.manifestMode).toBe('full-scan');
    expect(fast.manifestReason).toContain('unsafe stat config');
  });
  it.each([
    ['core.trustctime','yes'],['core.trustctime','1'],['core.checkStat','default'],
    ['core.fsmonitor','false'],['core.fsmonitor','off'],['core.untrackedCache','true'],['core.splitIndex','true'],
  ])('retains reuse with safe stat config %s=%s',async(key,value)=>{
    await git(['config',key,value]);
    expect((await compare()).manifestMode).toBe('git-delta');
  });
  it('hashes fsmonitor-valid leaves hidden from ls-files -v',async()=>{
    const hook=join(cwd,'.git','fsmonitor-hook');
    await fs.writeFile(hook,"#!/bin/sh\nprintf 'fixture-token\\0'\n",{mode:0o755});
    const monitor=['-c',`core.fsmonitor=${hook}`];
    await git([...monitor,'update-index','--fsmonitor']);
    await write('keep.txt','diff');
    await git([...monitor,'update-index','--fsmonitor-valid','keep.txt']);
    expect((await git([...monitor,'ls-files','-v','--','keep.txt'])).toString()).toBe('H keep.txt\n');
    expect((await git([...monitor,'ls-files','-f','-v','--','keep.txt'])).toString()).toBe('h keep.txt\n');
    // Isolate the flag guard from the separately tested config fallback: keep
    // real fsmonitor flags on index reads and inject its stale clean status.
    const monitored=call=>{
      if(call.args[0]==='status')return Promise.resolve({code:0,stdout:Buffer.alloc(0)});
      if(call.args[0]==='ls-files'&&call.args.includes('-v'))return exec({...call,args:[...monitor,...call.args]});
      return exec(call);
    };
    const spy=readSpy(),fast=await compare({fs:spy.fs,exec:monitored});
    expect(fast.manifestMode).toBe('git-delta');
    expect(fast.manifestDigest).not.toBe(base.manifestDigest);
    expect(readNames(spy.readFile)).toContain('keep.txt');
  });
  it.each(['failed','oversized','truncated','invalid key','invalid boolean','missing boolean'])('full-scans when stat config evidence is %s',async fault=>{
    const broken=async call=>{
      if(call.args[0]==='config') {
        if(fault==='failed')return {code:2,stdout:Buffer.alloc(0)};
        if(fault==='oversized')return {code:0,stdout:Buffer.alloc(4*1024*1024+1)};
        if(call.args.includes('--get-regexp'))return {code:0,stdout:Buffer.from(fault==='truncated'?'core.trustctime\ntrue':fault==='invalid key'?'core.unknown\ntrue\0':'core.trustctime\ntrue\0')};
        return {code:fault==='missing boolean'?1:0,stdout:Buffer.from(fault==='missing boolean'?'':'unknown\n')};
      }
      return exec(call);
    };
    const spy=readSpy(),fast=await compare({exec:broken,fs:spy.fs});
    expect(fast.manifestMode).toBe('full-scan');
    expect(fast.manifestReason).toContain('config evidence');
    expect(readNames(spy.readFile)).toEqual(['edit.txt','keep.txt','remove.txt']);
  });
  it('hashes a same-size write racing after status evidence',async()=>{
    let raced=false;
    const racing=async call=>{
      const result=await exec(call);
      if(call.args[0]==='status'&&!raced){raced=true;await write('keep.txt','race');}
      return result;
    };
    const spy=readSpy();await compare({exec:racing,fs:spy.fs});
    expect(readNames(spy.readFile)).toEqual(['keep.txt']);
  });
  it('hashes tracked-only and public credential leaves despite reuse',async()=>{
    await write('oauth-source.mjs','public');await git(['add','.']);await commit();await git(['update-ref','refs/remotes/origin/main','HEAD']);
    const full=await buildManifest({cwd,exec});
    const reuse=new Map(await Promise.all(full.entries.map(async entry=>{
      const stat=await fs.lstat(join(cwd,entry.path.toString()));
      return [entry.path.toString('hex'),{...entry,size:stat.size,stat}];
    })));
    const spy=readSpy();await buildManifest({cwd,exec,fs:spy.fs,reuse,trackedOnly:true});
    expect(readNames(spy.readFile)).toEqual(full.entries.map(entry=>entry.path.toString()).sort());
    const fast=await buildDeltaManifest({cwd,exec,fs:spy.fs,base:{sha:(await git(['rev-parse','HEAD'])).toString().trim(),manifest:manifestWire(full),manifestDigest:full.manifestDigest}});
    expect(fast.manifestMode).toBe('git-delta');expect(readNames(spy.readFile).filter(name=>name==='oauth-source.mjs')).toHaveLength(2);
  });
});
describe('ignored build output test policy',()=>{
  it.each(['_site','dist','build','out','coverage','.next','.vite','.cache','storybook-static','nested/dist'])('skips ignored whole build directory %s',async dir=>{
    await write('.gitignore',dir+'/\n');await fs.mkdir(join(cwd,dir),{recursive:true});
    await write(dir+'/output.test.mjs','stale output');
    const result=await buildManifest({cwd,exec});
    expect(result.entries.some(entry=>entry.path.toString().includes('output.test'))).toBe(false);
  });
  it.each(['tests/foo.test.mjs','dist/foo.test.mjs','nested/build/foo.test.mjs'])('refuses ignored tests when only the file is ignored: %s',async path=>{
    await fs.mkdir(join(cwd,path,'..'),{recursive:true});await write('.gitignore',path+'\n');await write(path,'hidden');
    await expect(buildManifest({cwd,exec})).rejects.toMatchObject({code:'ignored-test-file'});
  });
  it('refuses when whole-directory ignore evidence fails',async()=>{
    await write('.gitignore','dist/\n');await fs.mkdir(join(cwd,'dist'));await write('dist/a.test.mjs','hidden');
    const broken=call=>call.args[0]==='check-ignore'?Promise.resolve({code:2,stdout:Buffer.alloc(0)}):exec(call);
    await expect(buildManifest({cwd,exec:broken})).rejects.toThrow('Ignored directory evidence unavailable');
  });
});
