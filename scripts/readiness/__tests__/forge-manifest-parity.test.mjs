// @vitest-environment node
import {afterEach,beforeEach,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bindGit,buildManifest,buildDeltaManifest,defaultExec,runRemote} from '../remote-exec.mjs';
import {manifestWire} from '../forge-exec-manifest.mjs';
let root,cwd,base,env;
const sha=data=>createHash('sha256').update(data).digest('hex');
const git=(args,dir=cwd)=>{const r=spawnSync('git',args,{cwd:dir,env,maxBuffer:4*1024*1024});if(r.status)throw new Error(r.stderr.toString());return r.stdout;};
const write=async(name,data)=>{await fs.mkdir(join(cwd,name,'..'),{recursive:true});await fs.writeFile(join(cwd,name),data);};
const commit=()=>{git(['add','.']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);};
// Independent oracle: no Git inventory, policy helper or manifest builder.
async function oracle(dir=cwd,prefix='') {
  const entries=[];
  for(const name of await fs.readdir(dir)) {
    if(name==='.git'||name==='node_modules')continue;
    const path=prefix+name,absolute=join(dir,name),st=await fs.lstat(absolute);
    if(st.isDirectory())entries.push(...await oracle(absolute,path+'/'));
    else if(st.isFile())entries.push({path,sha256:sha(await fs.readFile(absolute)),executable:!!(st.mode&0o111)});
  }
  return entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}
beforeEach(async()=>{
  env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-parity-')));cwd=join(root,'work');await fs.mkdir(cwd);
  git(['init','-q']);await write('package-lock.json','{}');await write('keep.txt','keep');await write('a.test.mjs','test');commit();
  const full=await buildManifest({cwd,env});base={sha:git(['rev-parse','HEAD']).toString().trim(),manifest:manifestWire(full),manifestDigest:full.manifestDigest};
});

it('refuses a subdirectory or unreadable binding as unbound-worktree before remote dispatch',async()=>{
  const sub=join(cwd,'sub');await fs.mkdir(sub);
  await expect(bindGit({cwd:sub,env})).rejects.toMatchObject({code:'unbound-worktree'});
  const calls=[],exec=async call=>{calls.push(call);return {code:1,stdout:Buffer.alloc(0)};};
  const result=await runRemote({cwd,env,exec,argv:['npm','run','test:unit'],log:()=>{}});
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'unbound-worktree'});
  expect(calls.every(call=>call.file==='git')).toBe(true);
});

it.each(['unreadable','oversized'])('falls back locally before prepare for an %s filesystem walk',async fault=>{
  const io={...fs,readdir:async()=>{
    if(fault==='unreadable')throw Object.assign(new Error('denied'),{code:'EACCES'});
    return Array.from({length:100001},()=>Buffer.from('leaf'));
  }};
  const calls=[],exec=async call=>{
    calls.push(call);
    return call.file==='git'?defaultExec(call):{code:0,stdout:Buffer.from('{}')};
  };
  const result=await runRemote({cwd,env,exec,fs:io,disableDelta:true,argv:['npm','run','test:unit'],log:()=>{}});
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:fault==='oversized'?'manifest-walk-limit':'manifest-worktree-mismatch'});
  expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
});

it('ships every regular source through a committed memory bridge',async()=>{
  await write('agent-memory-src/MEMORY.md','x'.repeat(201));await fs.mkdir(join(cwd,'.claude'));
  await fs.symlink('../agent-memory-src',join(cwd,'.claude/agent-memory'));commit();
  const manifest=await buildManifest({cwd,env});
  const projection=manifest.entries.find(entry=>entry.path.toString()==='.claude/agent-memory/MEMORY.md');
  expect(projection.sha256).toBe(sha('x'.repeat(201)));
  expect(projection.sourcePath).toEqual(Buffer.from('agent-memory-src/MEMORY.md'));
});
afterEach(async()=>fs.rm(root,{recursive:true,force:true}));
const rows=[
  [1,'clean tree'],[2,'same-size edit with restored mtime'],[3,'GIT_DIR/GIT_WORK_TREE twin'],
  [4,'stale GIT_INDEX_FILE'],[5,'GIT_CONFIG_PARAMETERS checkstat=minimal'],
  [6,'info/exclude hides a lost test'],[7,'ignored dist test'],[8,'nested ignore hides a test'],
  [9,'GIT_CONFIG_GLOBAL excludesFile'],[10,'201-char memory index with omitted bridge'],
  [11,'extra untracked symlink'],[12,'bridge replaced by directory'],[13,'fsmonitor hook'],
  [14,'filter attribute'],[15,'deleted tracked file'],[16,'sub-millisecond staging mtime'],
];
it.each(rows)('row %i: %s',async row=>{
  let hostile={...env},omit=false,refuse=[6,7,8,10,11,12].includes(row);
  if(row===2){const st=await fs.stat(join(cwd,'keep.txt'));await write('keep.txt','diff');await fs.utimes(join(cwd,'keep.txt'),st.atimeMs/1000,st.mtimeMs/1000);}
  if(row===3){const twin=join(root,'twin');await fs.cp(cwd,twin,{recursive:true});await fs.writeFile(join(twin,'keep.txt'),'twin');hostile.GIT_DIR=join(twin,'.git');hostile.GIT_WORK_TREE=twin;}
  if(row===4){const stale=join(root,'stale-index');await fs.copyFile(join(cwd,'.git/index'),stale);await write('new.txt','new');git(['add','new.txt']);hostile.GIT_INDEX_FILE=stale;}
  if(row===5)hostile.GIT_CONFIG_PARAMETERS="'core.checkstat=minimal'";
  if(row===6){await write('scripts/build/lost.test.mjs','lost');await fs.writeFile(join(cwd,'.git/info/exclude'),'scripts/build/\n');omit=true;}
  if(row===7){await write('.gitignore','dist/\n');await write('dist/lost.test.mjs','lost');}
  if(row===8){await write('nested/.gitignore','*.test.mjs\n');await write('nested/lost.test.mjs','lost');omit=true;}
  if(row===9){const ignore=join(root,'ignore'),config=join(root,'global');await fs.writeFile(ignore,'hidden.txt\n');await fs.writeFile(config,`[core]\n excludesFile = ${ignore}\n`);hostile.GIT_CONFIG_GLOBAL=config;await write('hidden.txt','visible');}
  if([10,12].includes(row)){await write('agent-memory-src/MEMORY.md','x'.repeat(201));await fs.mkdir(join(cwd,'.claude'));if(row===10)await fs.symlink('../agent-memory-src',join(cwd,'.claude/agent-memory'));else await fs.mkdir(join(cwd,'.claude/agent-memory'));}
  if(row===11){await fs.symlink('keep.txt',join(cwd,'extra-link'));await fs.writeFile(join(cwd,'.git/info/exclude'),'extra-link\n');}
  if(row===13){await fs.writeFile(join(cwd,'.git/hooks/fsmonitor-fixture'),'#!/bin/sh\nexit 1\n',{mode:0o755});git(['config','core.fsmonitor','.git/hooks/fsmonitor-fixture']);}
  if(row===14){await write('.gitattributes','keep.txt filter=fixture\n');git(['config','filter.fixture.clean','printf keep']);await write('keep.txt','diff');}
  if(row===15)await fs.rm(join(cwd,'keep.txt'));
  const calls=[];
  const exec=async call=>{
    calls.push(call);
    // Reachability is fixture evidence, never a probe of the developer's host.
    if(call.file==='ssh'&&call.args.length===2&&call.args[1]==='true')return {code:0,stdout:Buffer.alloc(0)};
    if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
    if(omit&&call.file==='git'&&call.args.includes('-i'))return {code:0,stdout:Buffer.alloc(0)};
    return defaultExec({...call,env:call.env??hostile});
  };
  for(const delta of [false,true]) {
    const build=()=>delta?buildDeltaManifest({cwd,env:hostile,exec,base}):buildManifest({cwd,env:hostile,exec});
    if(refuse){await expect(build()).rejects.toThrow();continue;}
    const actual=await build();
    expect(actual.entries.map(({path,sha256,executable})=>({path:path.toString(),sha256,executable}))).toEqual(await oracle());
    if([3,4,5,9].includes(row))expect(calls.filter(c=>c.file==='git').every(c=>!Object.keys(c.env??hostile).some(k=>k.startsWith('GIT_')))).toBe(true);
    if(row===3)expect(calls.filter(c=>c.file==='git'&&!c.args.includes('--show-toplevel')&&!c.args.includes('--absolute-git-dir')).every(c=>c.args[0].startsWith('--git-dir='))).toBe(true);
  }
  if(refuse) {
    calls.length=0;
    const result=await runRemote({cwd,env:hostile,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
    expect(result).toMatchObject({mode:'not-started',terminated:true,reason:row===7?'ignored-test-file':[6,8].includes(row)?'unshipped-test-file':'unshipped-symlink'});
    expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
  }
  if(row===3) {
    let swapped=false;
    const racingFs={...fs,readdir:async(path,options)=>{
      if(!swapped&&String(path)===cwd) {
        swapped=true;await fs.rename(join(cwd,'keep.txt'),join(root,'old-leaf'));
        await fs.copyFile(join(root,'old-leaf'),join(cwd,'keep.txt'));
      }
      return fs.readdir(path,options);
    }};
    await expect(buildDeltaManifest({cwd,env:hostile,exec,fs:racingFs,base})).rejects.toMatchObject({code:'manifest-worktree-mismatch'});
  }
  if(row===16){
    const seconds=1700000000.123456;await fs.utimes(join(cwd,'keep.txt'),seconds,seconds);
    const stamp=await fs.stat(join(cwd,'keep.txt'),{bigint:true});let staged;
    const transport=async call=>{
      if(call.file==='git')return defaultExec(call);
      if(call.file==='rsync'){staged=await fs.stat(join(call.cwd,'keep.txt'),{bigint:true});return {code:1,stdout:Buffer.alloc(0)};}
      if(call.args.at(-1).endsWith(' prepare'))return {code:0,stdout:JSON.stringify({run:'r-'+'a'.repeat(32)})};
      return {code:0,stdout:Buffer.from('{}')};
    };
    await runRemote({cwd,env,exec:transport,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
    expect(staged).toBeDefined();expect(staged.mtimeNs).toBe(stamp.mtimeNs);
  }
});
