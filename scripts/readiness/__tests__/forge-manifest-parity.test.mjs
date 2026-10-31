// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {bindGit,buildManifest,buildDeltaManifest,defaultExec,runRemote} from '../remote-exec.mjs';
import {manifestWire} from '../forge-exec-manifest.mjs';
import {manifestMutation} from './fixtures/forge-bound-git.mjs';
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
    if(st.isDirectory()||(st.isSymbolicLink()&&(await fs.stat(absolute)).isDirectory()))entries.push(...await oracle(absolute,path+'/'));
    else if(st.isFile())entries.push({path,sha256:sha(await fs.readFile(absolute)),executable:!!(st.mode&0o111)});
  }
  return entries.sort((a,b)=>Buffer.compare(Buffer.from(a.path),Buffer.from(b.path)));
}
beforeEach(async()=>{
  env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-parity-')));cwd=join(root,'work');await fs.mkdir(cwd);
  git(['init','-q']);await write('package-lock.json','{}');await write('keep.txt','keep');await write('a.test.mjs','test');
  await fs.copyFile(new URL('./fixtures/forge-vitest.config.mjs',import.meta.url),join(cwd,'vitest.config.mjs'));commit();
  const full=await buildManifest({cwd,env});base={sha:git(['rev-parse','HEAD']).toString().trim(),manifest:manifestWire(full),manifestDigest:full.manifestDigest};
});

it.each(['missing configs','unreadable config','evaluation failure','invalid include glob','invalid exclude glob'])
('fails closed for an ignored build test with %s in full, delta and remote admission',async fault=>{
  const path='_site/assets/js/__tests__/x.test.ts';
  await write(path,'export {};');await write('.gitignore','_site/\n');
  if(fault==='missing configs')await fs.unlink(join(cwd,'vitest.config.mjs'));
  if(fault==='evaluation failure')await write('vitest.integration.config.mjs',"throw new Error('cannot evaluate discovery');\n");
  if(fault==='invalid include glob'||fault==='invalid exclude glob')await write('vitest.integration.config.mjs',
    `export default {test:{include:${fault==='invalid include glob'?"['[bad']":"[]"},exclude:${fault==='invalid exclude glob'?"['[bad']":"[]"}}};\n`);
  const io={...fs,readFile:async(file,...args)=>{
    if(fault==='unreadable config'&&String(file)===join(cwd,'vitest.config.mjs'))throw Object.assign(new Error('denied'),{code:'EACCES'});
    return fs.readFile(file,...args);
  }};
  await expect(buildManifest({cwd,env,fs:io})).rejects.toMatchObject({code:'ignored-test-file'});
  await expect(buildDeltaManifest({cwd,env,fs:io,base})).rejects.toMatchObject({code:'ignored-test-file'});
  const calls=[],exec=async call=>{
    calls.push(call);
    if(call.file==='ssh'&&call.args.length===2&&call.args[1]==='true')return {code:0,stdout:Buffer.alloc(0)};
    if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
    return defaultExec(call);
  };
  expect(await runRemote({cwd,env,fs:io,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}}))
    .toMatchObject({mode:'not-started',terminated:true,reason:'ignored-test-file'});
  expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
});

it('omits a config-excluded ignored test from full and delta entries',async()=>{
  const path='scripts/build/lost.test.mjs';
  await write(path,'export {};');await write('.gitignore','scripts/build/\n');
  await write('vitest.config.mjs',"export default {test:{include:['**/*.test.mjs'],exclude:['scripts/build/**']}};\n");
  for(const actual of [await buildManifest({cwd,env}),await buildDeltaManifest({cwd,env,base})]){
    expect(actual.entries.map(entry=>entry.path.toString())).not.toContain(path);
    expect(actual.excluded.map(entry=>entry.toString())).not.toContain(path);
  }
});

it('refuses a subdirectory or unreadable binding as unbound-worktree before remote dispatch',async()=>{
  const sub=join(cwd,'sub');await fs.mkdir(sub);
  await expect(bindGit({cwd:sub,env})).rejects.toMatchObject({code:'unbound-worktree'});
  const calls=[],exec=async call=>{calls.push(call);return {code:1,stdout:Buffer.alloc(0)};};
  const result=await runRemote({cwd,env,exec,argv:['npm','run','test:unit'],log:()=>{}});
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'unbound-worktree'});
  expect(calls.every(call=>call.file==='git')).toBe(true);
});

it.each([undefined,null])('bound exec uses its bound directory for cwd=%s without rebinding',async omitted=>{
  const calls=[],exec=async call=>{
    calls.push(call);
    if(calls.length>3)throw new Error('Repeated binding');
    return defaultExec(call);
  };
  const bound=await bindGit({cwd,env,exec});
  const call={file:'git',args:['rev-parse','--show-toplevel'],cwd:omitted};
  const result=await bound(call);
  expect(result.code).toBe(0);
  expect(result.stdout.toString().trim()).toBe(cwd);
  expect(calls).toHaveLength(2);
  expect(calls[1].cwd).toBe(cwd);
  expect(call.cwd).toBe(omitted);
});

it('buildDeltaManifest defaults cwd to process.cwd()',async()=>{
  const current=vi.spyOn(process,'cwd').mockReturnValue(cwd);
  try {
    const actual=await buildDeltaManifest({env,base});
    expect(manifestWire(actual)).toEqual(base.manifest);
    expect(actual.manifestMode).toBe('git-delta');
  } finally {current.mockRestore();}
});

const deletionFaults=[
  ['failed diff',1,'D\0keep.txt\0'],
  ['malformed status',0,'invalid\0other.txt\0D\0keep.txt\0'],
  ['missing record path',0,'D\0keep.txt\0D\0'],
  ['no deletion',0,''],
  ['wrong deleted path',0,'D\0other.txt\0'],
  ['non-deletion status',0,'M\0keep.txt\0'],
  ['unterminated record',0,'D\0keep.txt'],
  ['thrown diff',null,''],
];
it.each([
  ['failed diff',deletionFaults[0],"if(result.code!==0)throw manifestRefusal('manifest-worktree-mismatch',missing[0]);"],
  ['malformed record',deletionFaults[1],"if(!fields[i+1]||!/^[ACDMTUXB]$/.test(fields[i].toString()))throw manifestRefusal('manifest-worktree-mismatch',fields[i+1]??missing[0]);"],
  ['undeleted leaf',deletionFaults[3],"if(undeleted)throw manifestRefusal('manifest-worktree-mismatch',undeleted);"],
  ['entire deletion check',deletionFaults[3],'if(missing.length) {','if(false) {'],
])('deletion-evidence mutation gate kills removal of %s',async(_name,[_fault,code,stdout],find,replacement='')=>{
  await fs.rm(join(cwd,'keep.txt'));
  const exec=async call=>{
    if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
    if(call.args.includes('--name-status'))return {code,stdout:Buffer.from(stdout)};
    const result=await defaultExec(call);
    if(call.args.includes('-co'))return {...result,stdout:Buffer.from(result.stdout.toString().replace('keep.txt\0',''))};
    return result;
  };
  const options={cwd,env,exec};
  await expect(buildManifest(options)).rejects.toMatchObject({code:'manifest-worktree-mismatch'});
  const mutant=await manifestMutation(find,replacement);
  // The identical bad inventory is accepted only when its defending guard is gone.
  const escaped=await mutant.buildManifest(options);
  expect(escaped.entries.some(entry=>entry.path.equals(Buffer.from('keep.txt')))).toBe(false);
});
it.each(deletionFaults)('refuses missing tracked leaves without explicit deletion evidence: %s',async(_fault,code,stdout)=>{
  await fs.rm(join(cwd,'keep.txt'));
  for(const omit of [false,true]) {
    const calls=[],exec=async call=>{
      calls.push(call);
      if(call.file==='ssh'&&call.args.at(-1)==='true')return {code:0,stdout:Buffer.alloc(0)};
      if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
      if(call.args.includes('--name-status')){
        if(code===null)throw new Error('diff spawn failed');
        return {code,stdout:Buffer.from(stdout)};
      }
      const result=await defaultExec(call);
      // Exercise (d) independently of the earlier inventory missing-leaf check.
      if(omit&&call.args.includes('-co'))return {...result,stdout:Buffer.from(result.stdout.toString().replace('keep.txt\0',''))};
      return result;
    };
    for(const build of [()=>buildManifest({cwd,env,exec}),()=>buildDeltaManifest({cwd,env,exec,base})])
      await expect(build()).rejects.toMatchObject({code:'manifest-worktree-mismatch'});
    const result=await runRemote({cwd,env,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
    expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'manifest-worktree-mismatch'});
    expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
  }
});

it.each(['node_modules','credentials','.private','ＮＯＤＥ＿ＭＯＤＵＬＥＳ','node_\u200bmodules'])
('refuses policy-excluded tracked alias %s in full and delta manifests',async name=>{
  await write('vendor-src/leaf.js','export {};');await fs.mkdir(join(cwd,'tools'));
  await fs.symlink('../vendor-src',join(cwd,'tools',name));commit();
  for(const nested of [false,true]) {
    if(nested){await fs.symlink('tools',join(cwd,'outer'));commit();}
    const calls=[],exec=async call=>{
      calls.push(call);
      if(call.file==='git')return defaultExec(call);
      if(call.file==='ssh'&&call.args.at(-1)==='true')return {code:0,stdout:Buffer.alloc(0)};
      throw new Error(`Unexpected transport: ${call.file}`);
    };
    for(const build of [()=>buildManifest({cwd,env,exec}),()=>buildDeltaManifest({cwd,env,exec,base})])
      await expect(build()).rejects.toMatchObject({code:'unshipped-symlink'});
    const result=await runRemote({cwd,env,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
    expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'unshipped-symlink'});
    expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
  }
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

it.each(['untracked link','changed link bytes','escaping target','absolute escaping target','untracked target','unmerged link','linked parent','linked target','file target','missing traversal component','ignored target leaf'])
('checks %s before remote prepare or transfer',async fault=>{
  await write('skills-src/example/SKILL.md','# Skill\n');await write('other-src/leaf.md','other');
  await fs.mkdir(join(cwd,'tools'));
  const link='tools/alias';
  const target=fault==='escaping target'?'../../outside':fault==='absolute escaping target'?join(root,'outside'):fault==='file target'?'../keep.txt':fault==='missing traversal component'?'../missing/../skills-src':'../skills-src';
  if(fault.includes('escaping target')){await fs.mkdir(join(root,'outside'));await fs.writeFile(join(root,'outside/leaf.md'),'outside');}
  if(fault==='untracked link')commit();
  await fs.symlink(target,join(cwd,link));
  if(fault!=='untracked link')commit();
  if(fault==='changed link bytes'){await fs.unlink(join(cwd,link));await fs.symlink('../other-src',join(cwd,link));}
  if(fault==='untracked target')git(['rm','--cached','-r','skills-src']);
  if(fault==='linked parent'){await fs.rename(join(cwd,'tools'),join(cwd,'real-tools'));await fs.symlink('real-tools',join(cwd,'tools'));}
  if(fault==='linked target'){await fs.rename(join(cwd,'skills-src'),join(cwd,'real-source'));await fs.symlink('real-source',join(cwd,'skills-src'));}
  if(fault==='ignored target leaf'){await write('skills-src/hidden.txt','hidden');await fs.writeFile(join(cwd,'.git/info/exclude'),'skills-src/hidden.txt\n');}
  const calls=[],exec=async call=>{
    calls.push(call);
    if(call.file==='ssh'&&call.args.at(-1)==='true')return {code:0,stdout:Buffer.alloc(0)};
    if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
    const result=await defaultExec(call);
    if(fault==='unmerged link'&&call.args.includes('--stage'))return {...result,stdout:Buffer.from(result.stdout.toString().replace(' 0\ttools/alias',' 2\ttools/alias'))};
    return result;
  };
  if(fault==='ignored target leaf') {
    for(const build of [()=>buildManifest({cwd,env,exec}),()=>buildDeltaManifest({cwd,env,exec,base})]) {
      const actual=await build();
      const omitted=['skills-src/hidden.txt','tools/alias/hidden.txt'];
      expect(actual.entries.map(({path,sha256,executable})=>({path:path.toString(),sha256,executable})))
        .toEqual((await oracle()).filter(entry=>!omitted.includes(entry.path)));
      for(const path of omitted)expect(actual.entries.map(entry=>entry.path.toString())).not.toContain(path);
    }
    return;
  }
  await expect(buildManifest({cwd,env,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
  await expect(buildDeltaManifest({cwd,env,exec,base})).rejects.toMatchObject({code:'unshipped-symlink'});
  const result=await runRemote({cwd,env,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'unshipped-symlink'});
  expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
});

it('projects nested tracked links in inventory order and rejects projection cycles',async()=>{
  await write('outer-src/local.md','local');await write('inner-src/leaf.md','inner');
  await fs.symlink('../inner-src',join(cwd,'outer-src/inner'));
  await fs.symlink('outer-src',join(cwd,'alias'));commit();
  const manifest=await buildManifest({cwd,env});
  expect(manifest.entries.map(({path,sha256,executable})=>({path:path.toString(),sha256,executable}))).toEqual(await oracle());
  expect(manifest.entries.find(entry=>entry.path.toString()==='alias/inner/leaf.md').sourcePath).toEqual(Buffer.from('inner-src/leaf.md'));
  await fs.symlink('../outer-src',join(cwd,'inner-src/cycle'));commit();
  await expect(buildManifest({cwd,env})).rejects.toMatchObject({code:'unshipped-symlink'});
});

it('refuses excessive tracked-link expansion before remote dispatch',async()=>{
  for(let i=0;i<18;i++) {
    await write(`src-${i}/leaf.md`,'leaf');
    if(i)for(const name of ['a','b'])await fs.symlink(`../src-${i}`,join(cwd,`src-${i-1}/${name}`));
  }
  commit();
  const calls=[],exec=async call=>{
    calls.push(call);
    if(call.file==='git')return defaultExec(call);
    if(call.file==='ssh'&&call.args.at(-1)==='true')return {code:0,stdout:Buffer.alloc(0)};
    throw new Error(`Unexpected transport: ${call.file}`);
  };
  const result=await runRemote({cwd,env,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'manifest-walk-limit'});
  expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
});

it('refuses excessive ignored-leaf alias expansion with local fallback before transport',async()=>{
  for(let i=0;i<13;i++) {
    await write(`src-${i}/leaf.md`,'leaf');
    if(i)for(const name of ['a','b'])await fs.symlink(`../src-${i}`,join(cwd,`src-${i-1}/${name}`));
  }
  commit();
  await expect(buildManifest({cwd,env})).resolves.toHaveProperty('manifestDigest');
  const ignored=[];
  for(let i=0;i<3;i++) {
    const path=`src-12/${'h'.repeat(230)}${i}.json`;
    await write(path,'{}');ignored.push(path);
  }
  await fs.writeFile(join(cwd,'.git/info/exclude'),ignored.join('\n')+'\n');
  const calls=[],exec=async call=>{
    calls.push(call);
    if(call.file==='ssh'&&call.args.at(-1)==='true')return {code:0,stdout:Buffer.alloc(0)};
    if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
    return defaultExec(call);
  };
  for(const build of [()=>buildManifest({cwd,env,exec}),()=>buildDeltaManifest({cwd,env,exec,base})])
    await expect(build()).rejects.toMatchObject({code:'manifest-walk-limit'});
  const result=await runRemote({cwd,env,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'manifest-walk-limit'});
  expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
  // Real Git plus a successful expanded baseline and three refusal scans need
  // the integration budget on busy CI shards; keep the production limits intact.
},30000);

it.each(['.claude/skills','tools/alias'])('transfers %s leaves even when a warm base has identical projected bytes',async link=>{
  await write('skills-src/leaf.md','skill');await fs.mkdir(join(cwd,link,'..'));
  await fs.symlink('../skills-src',join(cwd,link));commit();
  const full=await buildManifest({cwd,env});
  const warm={sha:git(['rev-parse','HEAD']).toString().trim(),manifest:manifestWire(full),manifestDigest:full.manifestDigest};
  const delta=await buildDeltaManifest({cwd,env,base:warm});
  expect(delta.manifestMode).toBe('git-delta');
  expect(manifestWire(delta)).toEqual(manifestWire(full));
  expect(delta.deltaPaths).toContainEqual(Buffer.from(link+'/leaf.md'));
});

it('rechecks a projected link during staging before prepare or rsync',async()=>{
  await write('skills-src/leaf.md','skill');await write('other-src/leaf.md','skill');
  await fs.mkdir(join(cwd,'.claude'));await fs.symlink('../skills-src',join(cwd,'.claude/skills'));commit();
  let swapped=false;
  const io={...fs,mkdtemp:async(...args)=>{
    const dir=await fs.mkdtemp(...args);
    await fs.unlink(join(cwd,'.claude/skills'));await fs.symlink('../other-src',join(cwd,'.claude/skills'));swapped=true;
    return dir;
  }};
  const calls=[],exec=async call=>{
    calls.push(call);
    if(call.file==='git')return defaultExec(call);
    if(call.file==='ssh'&&call.args.at(-1)==='true')return {code:0,stdout:Buffer.alloc(0)};
    throw new Error(`Unexpected transport: ${call.file}`);
  };
  const result=await runRemote({cwd,env,exec,fs:io,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
  expect(swapped).toBe(true);
  expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'snapshot-staging-failed'});
  expect(calls.some(call=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
});
afterEach(async()=>fs.rm(root,{recursive:true,force:true}));
const rows=[
  [1,'clean tree'],[2,'same-size edit with restored mtime'],[3,'GIT_DIR/GIT_WORK_TREE twin'],
  [4,'stale GIT_INDEX_FILE'],[5,'GIT_CONFIG_PARAMETERS checkstat=minimal'],
  [6,'info/exclude hides a lost test'],[7,'ignored dist test'],[8,'nested ignore hides a test'],
  [9,'GIT_CONFIG_GLOBAL excludesFile'],[10,'201-char memory index with omitted bridge'],
  [11,'extra untracked symlink'],[12,'bridge replaced by directory'],[13,'fsmonitor hook'],
  [14,'filter attribute'],[15,'deleted tracked file'],[16,'sub-millisecond staging mtime'],
  [17,'tracked directory symlink projects skills'],
  [18,'tracked directory symlink has no special path name'],
  [19,'tracked directory symlink with an absolute in-repo target'],
  [20,'tracked directory symlink omits ignored runtime data files projected into excluded .claude/skills'],
  [21,'tracked directory symlink still refuses an ignored untracked source symlink'],
  [22,'tracked directory symlink still requires an omitted non-ignored source file'],
  [23,'tracked directory symlink still refuses an ignored policy-excluded source file'],
  [24,'tracked directory symlink still refuses a policy-excluded source file'],
  [25,'tracked directory symlink still refuses an ignored test file'],
  [26,'tests -> runtime-src refuses gitignored runtime-src/hidden.js'],
  [27,'nested tracked directory links refuse an ignored leaf projected into tests'],
  [28,'tracked directory symlink refuses an ignored leaf projected into an excluded path'],
  [29,'nested tracked directory links refuse an ignored leaf projected into an excluded path'],
  [30,'nested tracked directory links omit an ignored non-test leaf at every alias'],
  [31,'allowed tracked directory alias omits ignored runtime files beside a node_modules/.bin symlink'],
  [32,'ignored _site test outside all Vitest includes is omitted'],
  [33,'ignored _site test selected only by integration config still refuses'],
];
it.each(rows)('row %i: %s',async row=>{
  let hostile={...env},omit=false,refuse=[6,7,8,10,11,12,21,22,23,24,25,26,27,28,29,33].includes(row);
  const omitted=[];
  if(row===32||row===33){
    const path='_site/assets/js/__tests__/x.test.ts';
    await write(path,'export {};');await write('.gitignore','_site/\n');omitted.push(path);
    if(row===33)await write('vitest.integration.config.mjs',"export default {test:{include:['_site/**/*.test.ts'],exclude:[]}};\n");
  }
  if(row===2){const st=await fs.stat(join(cwd,'keep.txt'));await write('keep.txt','diff');await fs.utimes(join(cwd,'keep.txt'),st.atimeMs/1000,st.mtimeMs/1000);}
  if(row===3){const twin=join(root,'twin');await fs.cp(cwd,twin,{recursive:true});await fs.writeFile(join(twin,'keep.txt'),'twin');hostile.GIT_DIR=join(twin,'.git');hostile.GIT_WORK_TREE=twin;}
  if(row===4){const stale=join(root,'stale-index');await fs.copyFile(join(cwd,'.git/index'),stale);await write('new.txt','new');git(['add','new.txt']);hostile.GIT_INDEX_FILE=stale;}
  if(row===5)hostile.GIT_CONFIG_PARAMETERS="'core.checkstat=minimal'";
  if(row===6){await write('scripts/build/lost.test.mjs','lost');await fs.writeFile(join(cwd,'.git/info/exclude'),'scripts/build/\n');omit=true;}
  if(row===7){await write('.gitignore','dist/\n');await write('dist/lost.test.mjs','lost');}
  if(row===8){await write('nested/.gitignore','*.test.mjs\n');await write('nested/lost.test.mjs','lost');omit=true;}
  if(row===9){const ignore=join(root,'ignore'),config=join(root,'global');await fs.writeFile(ignore,'hidden.txt\n');await fs.writeFile(config,`[core]\n excludesFile = ${ignore}\n`);hostile.GIT_CONFIG_GLOBAL=config;await write('hidden.txt','visible');}
  if([10,12].includes(row)){
    await write('agent-memory-src/MEMORY.md','x'.repeat(201));await fs.mkdir(join(cwd,'.claude'));
    await fs.symlink('../agent-memory-src',join(cwd,'.claude/agent-memory'));
    if(row===12){commit();await fs.unlink(join(cwd,'.claude/agent-memory'));await fs.mkdir(join(cwd,'.claude/agent-memory'));}
  }
  if(row===11){await fs.symlink('keep.txt',join(cwd,'extra-link'));await fs.writeFile(join(cwd,'.git/info/exclude'),'extra-link\n');}
  if(row===13){await fs.writeFile(join(cwd,'.git/hooks/fsmonitor-fixture'),'#!/bin/sh\ntouch .git/fsmonitor-ran\nexit 1\n',{mode:0o755});git(['config','core.fsmonitor','.git/hooks/fsmonitor-fixture']);}
  if(row===14){await write('.gitattributes','keep.txt filter=fixture\n');git(['config','filter.fixture.clean','printf keep']);await write('keep.txt','diff');}
  if(row===15)await fs.rm(join(cwd,'keep.txt'));
  if(row>=17&&row<=25||row===31){
    await write('skills-src/example/SKILL.md','# Skill\n');await write('skills-src/example/run.mjs','export {};\n');
    await fs.chmod(join(cwd,'skills-src/example/run.mjs'),0o755);
    const parent=row===31?'.github':row===17||row>=20?'.claude':'tools';await fs.mkdir(join(cwd,parent));
    await fs.symlink(row===19?join(cwd,'skills-src'):'../skills-src',join(cwd,parent,parent==='tools'?'alias':'skills'));commit();
  }
  if(row>=20&&row<=25||row===31){
    const runtime=['example/claims.json','example/id-ledger.json','example/reservations.json','example/prepare-hold.json','drain/review-baseline-state.json'];
    for(const path of runtime){
      await write('skills-src/'+path,'{}');
      omitted.push('skills-src/'+path,(row===31?'.github':'.claude')+'/skills/'+path);
    }
    const ignores=runtime.map(path=>'skills-src/'+path).concat('node_modules/');
    await fs.mkdir(join(cwd,'skills-src/example/node_modules/.bin'),{recursive:true});
    await fs.symlink('../../run.mjs',join(cwd,'skills-src/example/node_modules/.bin/run'));
    if(row===21){await fs.symlink('run.mjs',join(cwd,'skills-src/example/extra-link'));ignores.push('skills-src/example/extra-link');}
    if(row===22)await write('skills-src/example/unlisted.json','{}');
    if([23,24].includes(row)){
      await write('skills-src/example/.private','private');
      if(row===23)ignores.push('skills-src/example/.private');
    }
    if(row===25){await write('skills-src/example/hidden.test.mjs','test');ignores.push('skills-src/example/hidden.test.mjs');}
    await fs.writeFile(join(cwd,'.git/info/exclude'),ignores.join('\n')+'\n');
  }
  if(row>=26&&row<=30){
    await write('runtime-src/keep.txt','keep');
    const alias=[26,27].includes(row)?'tests':[28,29].includes(row)?'.private':'tools';
    const nested=[27,29,30].includes(row);
    if(nested){
      await fs.mkdir(join(cwd,'bridge'));
      await fs.symlink('../runtime-src',join(cwd,'bridge/inner'));
    }
    await fs.symlink(nested?'bridge':'runtime-src',join(cwd,alias));commit();
    await write('runtime-src/hidden.js','hidden');
    await fs.writeFile(join(cwd,'.git/info/exclude'),'runtime-src/hidden.js\n');
    omitted.push('runtime-src/hidden.js',nested?`${alias}/inner/hidden.js`:`${alias}/hidden.js`);
    if(nested)omitted.push('bridge/inner/hidden.js');
  }
  const calls=[];
  const exec=async call=>{
    calls.push(call);
    // Reachability is fixture evidence, never a probe of the developer's host.
    if(call.file==='ssh'&&call.args.length===2&&call.args[1]==='true')return {code:0,stdout:Buffer.alloc(0)};
    if(call.file!=='git')throw new Error(`Unexpected transport: ${call.file}`);
    if(omit&&call.file==='git'&&call.args.includes('-i'))return {code:0,stdout:Buffer.alloc(0)};
    const result=await defaultExec({...call,env:call.env??hostile});
    if(row===22&&call.args.includes('-co'))return {...result,stdout:Buffer.from(result.stdout.toString().replace('skills-src/example/unlisted.json\0',''))};
    return result;
  };
  for(const delta of [false,true]) {
    const build=()=>delta?buildDeltaManifest({cwd,env:hostile,exec,base}):buildManifest({cwd,env:hostile,exec});
    if(refuse){
      if(row>=20)await expect(build()).rejects.toMatchObject({code:[25,33].includes(row)?'ignored-test-file':'unshipped-symlink'});
      else await expect(build()).rejects.toThrow();
      continue;
    }
    const actual=await build();
    expect(actual.entries.map(({path,sha256,executable})=>({path:path.toString(),sha256,executable})))
      .toEqual((await oracle()).filter(entry=>!omitted.includes(entry.path)));
    for(const path of omitted)expect(actual.entries.map(entry=>entry.path.toString())).not.toContain(path);
    if(row===13){
      await expect(fs.lstat(join(cwd,'.git/fsmonitor-ran'))).rejects.toMatchObject({code:'ENOENT'});
      expect(calls.filter(call=>call.file==='git'&&!call.args.includes('--show-toplevel'))
        .every(call=>call.args[2]==='-c'&&call.args[3]==='core.fsmonitor=false')).toBe(true);
    }
    if(row===31)expect(actual.entries.every(entry=>!entry.path.toString().split('/').includes('node_modules'))).toBe(true);
    if([3,4,5,9].includes(row))expect(calls.filter(c=>c.file==='git').every(c=>!Object.keys(c.env??hostile).some(k=>k.startsWith('GIT_')))).toBe(true);
    if(row===3)expect(calls.filter(c=>c.file==='git'&&!c.args.includes('--show-toplevel')&&!c.args.includes('--absolute-git-dir')).every(c=>c.args[0].startsWith('--git-dir='))).toBe(true);
  }
  if(refuse) {
    calls.length=0;
    const result=await runRemote({cwd,env:hostile,exec,disableDelta:true,argv:['npm','run','test:unit','--','a.test.mjs'],log:()=>{}});
    expect(result).toMatchObject({mode:'not-started',terminated:true,reason:[7,25,33].includes(row)?'ignored-test-file':[6,8].includes(row)?'unshipped-test-file':'unshipped-symlink'});
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
