// @vitest-environment node
import {gitArgs,bindingEvidence} from './fixtures/forge-bound-git.mjs';
import {describe,it,expect,beforeEach,afterEach,vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import * as remote from '../remote-exec.mjs';
import {BASE_RETENTION,baseGuard,claimPrewarm,copyLeaves,createBasePin,pruneBases,readyBases,readBase} from '../forge-exec-bases.mjs';
import {parseGitTree} from '../forge-exec-manifest.mjs';
import {createRunner,manifestWire,digestManifest,digestInput,digestArgv} from '../forge-exec-run.mjs';
let root,repo;
const hash=data=>createHash('sha256').update(data).digest('hex');
const git=(args,cwd=repo)=>{const r=spawnSync('git',args,{cwd,maxBuffer:4*1024*1024});if(r.status)throw new Error(r.stderr.toString());return r.stdout;};
const exec=async ({file,args,cwd,env,input})=>{const r=spawnSync(file,args,{cwd,env,input,maxBuffer:4*1024*1024});return {code:r.status,stdout:r.stdout};};
const commit=()=>git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
beforeEach(async()=>{
  root=await fs.realpath(await fs.mkdtemp(join(process.env.TMPDIR,'forge-offload-')));repo=join(root,'repo');await fs.mkdir(repo);
  git(['init','-q']);
  for(const [name,data] of Object.entries({'package-lock.json':'lock','a.test.mjs':'test','deleted.txt':'delete','mode.txt':'mode','oauth-source.mjs':'public','credentials.txt':'private'})) await fs.writeFile(join(repo,name),data);
  git(['add','.']);commit();git(['update-ref','refs/remotes/origin/main','HEAD']);
});
afterEach(async()=>{vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
async function baseFixture() {
  const sha=git(['rev-parse','HEAD']).toString().trim();
  const manifest=await remote.buildManifest({cwd:repo,exec});
  return {sha,manifest:manifestWire(manifest),manifestDigest:manifest.manifestDigest};
}
async function pruningFixture() {
  const target=join(root,'pruning');await fs.mkdir(target,{mode:0o700});
  const shas=Array.from({length:BASE_RETENTION+2},(_,i)=>i.toString(16).repeat(40));
  for(const [i,sha] of shas.entries()) {
    await fs.mkdir(join(target,sha));
    await fs.writeFile(join(target,sha,'READY'),JSON.stringify({sha,manifestDigest:hash('manifest'),lockDigest:hash('lock'),readyAtMs:i,fetchedAtMs:i}));
    await fs.writeFile(join(target,sha,'keep'),'base '+i);
  }
  await fs.mkdir(join(target,'failed.tmp'));
  return {target,shas};
}
describe('base directory trust boundary',()=>{
  it.each([0o775,0o757,0o777,'symlink'])('refuses an unsafe base root (%s) at every reader and guard',async fault=>{
    const {target}=await pruningFixture();
    if(fault==='symlink'){await fs.rename(target,target+'.saved');await fs.symlink(target+'.saved',target);}
    else await fs.chmod(target,fault);
    const action=vi.fn();
    await expect(readyBases(target)).rejects.toThrow('Unsafe base directory');
    await expect(readBase(target,'0'.repeat(40),hash('manifest'))).rejects.toThrow('Unsafe base directory');
    await expect(baseGuard(target,action)).rejects.toThrow('Unsafe base directory');
    expect(action).not.toHaveBeenCalled();
  });
  it.each([0o775,0o757,0o777,'symlink'])('never advertises or reads an unsafe SHA directory (%s)',async fault=>{
    const {target,shas}=await pruningFixture(),sha=shas[0],base=join(target,sha);
    expect((await readyBases(target)).map(record=>record.sha)).toContain(sha);
    if(fault==='symlink'){await fs.rename(base,base+'.saved');await fs.symlink(base+'.saved',base);}
    else await fs.chmod(base,fault);
    expect((await readyBases(target)).map(record=>record.sha)).not.toContain(sha);
    await expect(readBase(target,sha,hash('manifest'))).rejects.toThrow('Unsafe base directory');
  });
  it.each(['symlink','directory'])('never advertises or reads READY replaced by a %s',async fault=>{
    const {target,shas}=await pruningFixture(),sha=shas[0],ready=join(target,sha,'READY');
    await fs.rename(ready,ready+'.saved');
    if(fault==='symlink')await fs.symlink(ready+'.saved',ready);else await fs.mkdir(ready);
    expect((await readyBases(target)).map(record=>record.sha)).not.toContain(sha);
    await expect(readBase(target,sha,hash('manifest'))).rejects.toThrow();
  });
  it('refuses a symlinked guard without entering or modifying its target',async()=>{
    const target=join(root,'guard-root'),victim=join(root,'guard-victim');
    await fs.mkdir(target);await fs.mkdir(victim);await fs.writeFile(join(victim,'keep'),'unchanged');
    await fs.symlink(victim,join(target,'.guard'));
    const action=vi.fn();
    await expect(baseGuard(target,action)).rejects.toThrow('Unsafe base guard');
    expect(action).not.toHaveBeenCalled();expect(await fs.readFile(join(victim,'keep'),'utf8')).toBe('unchanged');
    expect(await fs.readdir(target)).toEqual(['.guard']);
  });
});

describe('active base pin safety',()=>{
  async function guardFixture(owner={pid:process.pid,timestamp:Date.now()}) {
    const target=join(root,'guard-test'),guard=join(target,'.guard');
    await fs.mkdir(guard,{recursive:true,mode:0o700});
    await fs.writeFile(join(guard,'owner-'+ 'a'.repeat(32)),JSON.stringify(owner));
    return {target,guard};
  }
  it('contention waits then succeeds when the holder releases',async()=>{
    const target=join(root,'guard-test');await fs.mkdir(target);
    let release,entered;
    const ready=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
    const first=baseGuard(target,async()=>{entered();await held;});await ready;
    let now=0;const sleep=vi.fn(async ms=>{now+=ms;release();await first;});
    const action=vi.fn(()=>42);
    expect(await baseGuard(target,action,fs,{clock:()=>now,sleep,waitMs:100})).toBe(42);
    expect(sleep).toHaveBeenCalledOnce();expect(action).toHaveBeenCalledOnce();
    expect(await fs.readdir(target)).toEqual([]);
  });
  it('fails within its wait bound when held and never steals a live old holder',async()=>{
    const {target,guard}=await guardFixture({pid:process.pid,timestamp:0});
    await fs.utimes(guard,new Date(0),new Date(0));
    let now=100000000;const action=vi.fn(),sleep=vi.fn(async ms=>{now+=ms;});
    await expect(baseGuard(target,action,fs,{clock:()=>now,sleep,waitMs:50,retryMs:25,maxAgeMs:1})).rejects.toThrow('Base guard wait exceeded; use local fallback');
    expect(sleep).toHaveBeenCalledTimes(2);expect(action).not.toHaveBeenCalled();
    expect(await fs.readdir(guard)).toEqual(['owner-'+ 'a'.repeat(32)]);
  });
  it.each([
    ['lstat','EACCES'],['lstat','EPERM'],
    ['readdir','EACCES'],['readdir','EPERM'],
    ['open','EACCES'],['open','EPERM'],
  ])('waits to the bounded error without removing a guard when %s throws %s',async(operation,code)=>{
    const {target,guard}=await guardFixture({pid:0,timestamp:0});
    await fs.utimes(guard,new Date(0),new Date(0));
    const owner=join(guard,'owner-'+ 'a'.repeat(32));
    const inspect=vi.fn(async(path,...args)=>{
      if(String(path)===(operation==='open'?owner:guard))throw Object.assign(new Error('denied'),{code});
      return fs[operation](path,...args);
    });
    const io={...fs,[operation]:inspect,unlink:vi.fn(fs.unlink),rmdir:vi.fn(fs.rmdir)};
    let now=100000000;const action=vi.fn(),sleep=vi.fn(async ms=>{now+=ms;});
    await expect(baseGuard(target,action,io,{clock:()=>now,sleep,waitMs:50,retryMs:25,maxAgeMs:1}))
      .rejects.toThrow('Base guard wait exceeded; use local fallback and inspect the guard owner');
    expect(sleep.mock.calls).toEqual([[25],[25]]);expect(now).toBe(100000050);
    expect(action).not.toHaveBeenCalled();expect(io.unlink).not.toHaveBeenCalled();expect(io.rmdir).not.toHaveBeenCalled();
    expect(await fs.readdir(guard)).toEqual(['owner-'+ 'a'.repeat(32)]);
    expect(await fs.readdir(target)).toEqual(['.guard']);
  });
  it.each(['dead pid','old unknown owner'])('recovers a stale guard with %s',async fault=>{
    const {target,guard}=await guardFixture({pid:fault==='dead pid'?123456:0,timestamp:0});
    await fs.utimes(guard,new Date(0),new Date(0));
    const kill=vi.fn(()=>{throw Object.assign(new Error('dead'),{code:'ESRCH'});}),action=vi.fn(()=>42);
    expect(await baseGuard(target,action,fs,{kill,maxAgeMs:1})).toBe(42);
    expect(action).toHaveBeenCalledOnce();expect(await fs.readdir(target)).toEqual([]);
  });
  it('recovers an old empty guard left before owner publication',async()=>{
    const {target,guard}=await guardFixture();
    await fs.unlink(join(guard,'owner-'+ 'a'.repeat(32)));await fs.utimes(guard,new Date(0),new Date(0));
    expect(await baseGuard(target,()=>42,fs,{maxAgeMs:1})).toBe(42);
    expect(await fs.readdir(target)).toEqual([]);
  });
  it('keeps stale recovery exclusive when another contender publishes first',async()=>{
    const {target}=await guardFixture({pid:123456,timestamp:0});
    let holders=0,maxHolders=0;
    const options={kill:pid=>{if(pid===123456)throw Object.assign(new Error('dead'),{code:'ESRCH'});},retryMs:1};
    const action=async()=>{holders++;maxHolders=Math.max(maxHolders,holders);await new Promise(resolve=>setTimeout(resolve,5));holders--;};
    await Promise.all([baseGuard(target,action,fs,options),baseGuard(target,action,fs,options)]);
    expect(maxHolders).toBe(1);expect(await fs.readdir(target)).toEqual([]);
  });
  it('a delayed initializer cannot replace a live successor after its empty guard ages out',async()=>{
    const target=join(root,'guard-test');await fs.mkdir(target);
    let pause,resume;
    const paused=new Promise(resolve=>pause=resolve),resumed=new Promise(resolve=>resume=resolve);
    const io={...fs,rename:async(from,to)=>{
      if(String(to)===join(target,'.guard')){pause();await resumed;}
      return fs.rename(from,to);
    }};
    let now=0;const lateAction=vi.fn();
    const late=baseGuard(target,lateAction,io,{clock:()=>now,waitMs:50,sleep:async ms=>{now+=ms;}});
    await paused;await fs.utimes(join(target,'.guard'),new Date(0),new Date(0));
    await baseGuard(target,async()=>{
      resume();await expect(late).rejects.toThrow('Base guard wait exceeded');expect(lateAction).not.toHaveBeenCalled();
    },fs,{maxAgeMs:1});
    expect(await fs.readdir(target)).toEqual([]);
  });
  it('does not steal a holder whose PID probe is permission denied',async()=>{
    const {target,guard}=await guardFixture();let now=0;
    await expect(baseGuard(target,vi.fn(),fs,{clock:()=>now,sleep:async ms=>{now+=ms;},waitMs:25,
      kill:()=>{throw Object.assign(new Error('denied'),{code:'EPERM'});}})).rejects.toThrow('Base guard wait exceeded');
    expect(await fs.readdir(guard)).toHaveLength(1);
  });
  it.each(['garbage','unreadable'])('refuses pruning with a %s active pin and keeps every base',async fault=>{
    const {target,shas}=await pruningFixture(),active=join(target,'active');
    await fs.mkdir(active,{mode:0o700});
    const pin=join(active,'run-one');await fs.writeFile(pin,fault==='garbage'?'not-a-sha':shas[0],{mode:0o600});
    const before=(await fs.readdir(target)).sort();
    const remove=vi.fn(fs.rm);
    const io={...fs,rm:remove,open:async(path,...args)=>{
      if(fault==='unreadable'&&String(path)===pin)throw Object.assign(new Error('pin denied'),{code:'EACCES'});
      return fs.open(path,...args);
    }};
    if(fault==='garbage')await expect(pruneBases(target,io)).rejects.toThrow('Unreadable active base pin: pruning refused');
    else await expect(pruneBases(target,io)).rejects.toMatchObject({code:'EACCES'});
    expect(remove).not.toHaveBeenCalled();
    expect((await fs.readdir(target)).sort()).toEqual(before);
    for(const [i,sha] of shas.entries())expect(await fs.readFile(join(target,sha,'keep'),'utf8')).toBe('base '+i);
    expect(await fs.readFile(pin,'utf8')).toBe(fault==='garbage'?'not-a-sha':shas[0]);
  });
  it('ops can read root-created active base pins and retain the pinned base',async()=>{
    const {target,shas}=await pruningFixture(),active=join(target,'active'),pin=join(active,'run-one');
    const operator={uid:1001,gid:1002},owners=new Map(),transfers=[];
    let asOps=false;
    const checkOps=path=>{
      if(!asOps)return;
      for(const name of [active,...(String(path)===pin?[pin]:[])]) {
        if(owners.get(name)?.uid!==operator.uid)throw Object.assign(new Error('ops cannot read root-owned pin metadata'),{code:'EACCES'});
      }
    };
    const io={...fs,
      mkdir:async(path,options)=>{await fs.mkdir(path,options);if(!owners.has(String(path)))owners.set(String(path),{uid:0,gid:0});},
      writeFile:async(path,...args)=>{await fs.writeFile(path,...args);owners.set(String(path),{uid:0,gid:0});},
      lstat:async path=>{checkOps(path);return fs.lstat(path);},
      readdir:async path=>{checkOps(path);return fs.readdir(path);},
      open:async(path,flags)=>{
        checkOps(path);
        const fd=await fs.open(path,flags);
        return {stat:async()=>Object.assign(await fd.stat(),owners.get(String(path))),
          readFile:()=>fd.readFile(),close:()=>fd.close(),
          chown:async(uid,gid)=>{transfers.push({path:String(path),uid,gid});owners.set(String(path),{uid,gid});}};
      },
    };
    // Run the same pin creator used by privileged prepare/run; only identity
    // and fchown are simulated, while metadata creation and pruning use disk.
    await createBasePin(target,'run-one',shas[0],operator,io);
    expect(transfers).toEqual([{path:active,...operator},{path:pin,...operator}]);
    expect((await fs.stat(active)).mode&0o777).toBe(0o700);
    expect((await fs.stat(pin)).mode&0o777).toBe(0o600);
    asOps=true;
    const reader=await io.open(pin,0);
    try{expect((await reader.readFile()).toString()).toBe(shas[0]);}finally{await reader.close();}
    await pruneBases(target,io);
    expect(await fs.readdir(target)).toEqual(expect.arrayContaining([shas[0],...shas.slice(2)]));
    await expect(fs.stat(join(target,shas[1]))).rejects.toMatchObject({code:'ENOENT'});
    await expect(fs.stat(join(target,'failed.tmp'))).rejects.toMatchObject({code:'ENOENT'});
  });
});
describe('warm base selection and delta proof',()=>{
  it('hashes Mac index membership even when tracked and untracked file bytes are identical',async()=>{
    await fs.writeFile(join(repo,'new.md'),'same bytes');
    const untracked=await remote.buildManifest({cwd:repo,exec});
    expect(untracked.entries.find(e=>e.path.toString()==='new.md').tracked).toBe(false);
    git(['add','new.md']);
    const tracked=await remote.buildManifest({cwd:repo,exec});
    expect(tracked.entries.find(e=>e.path.toString()==='new.md').tracked).toBe(true);
    expect(tracked.manifestDigest).not.toBe(untracked.manifestDigest);
    const base=await baseFixture();
    git(['rm','--cached','new.md']);
    const delta=await remote.buildDeltaManifest({cwd:repo,exec,base});
    expect(delta.entries.find(e=>e.path.toString()==='new.md').tracked).toBe(false);
    expect(delta.deltaPaths).toEqual([]);
    expect(delta.manifestDigest).toBe((await remote.buildManifest({cwd:repo,exec})).manifestDigest);
    expect(delta.manifestDigest).not.toBe(base.manifestDigest);
  });
  it('refuses a legacy warm-base manifest with its valid historical digest and requires full shipping',async()=>{
    const base=await baseFixture();
    delete base.manifest.v;delete base.manifest.tracked;
    base.manifestDigest=digestManifest(base.manifest);
    await expect(remote.buildDeltaManifest({cwd:repo,exec,base})).rejects.toThrow(/manifest|full ship/i);
  });
  it.each([['120000','blob'],['160000','commit']])('retains excluded %s tree entries for manifest policy', (mode,type)=>{
    const oid='a'.repeat(40);
    const tree=Buffer.from([`${mode} ${type} ${oid}\t.claude/skills`,`${mode} ${type} ${oid}\t.claude/agent-memory`,`100644 blob ${oid}\tnormal.txt`,''].join('\0'));
    expect(parseGitTree(tree).map(entry=>entry.path.toString())).toEqual(['.claude/skills','.claude/agent-memory','normal.txt']);
  });
  it.each([['120000','blob','skills'],['160000','commit','module'],['120000','blob','oauth-source.mjs']])('rejects non-excluded %s tree entry %s %s', (mode,type,path)=>{
    expect(()=>parseGitTree(Buffer.from(`${mode} ${type} ${'a'.repeat(40)}\t${path}\0`))).toThrow('Unsupported git tree mode');
  });
  it('retains symlinks only as delta tree evidence while refusing gitlinks and default exports',()=>{
    const oid='a'.repeat(40),link=Buffer.from(`120000 blob ${oid} 9\ttools/alias\0`);
    expect(parseGitTree(link,{sizes:true,links:true})).toEqual([{path:Buffer.from('tools/alias'),oid,executable:false,symlink:true,size:9}]);
    expect(()=>parseGitTree(link,{sizes:true})).toThrow('Unsupported git tree mode');
    expect(()=>parseGitTree(Buffer.from(`160000 commit ${oid} -\ttools/module\0`),{sizes:true,links:true})).toThrow('Unsupported git tree mode');
  });
  it('refuses tracked symlinks to files in full and delta manifests even when the base predates them',async()=>{
    const base=await baseFixture();
    await fs.mkdir(join(repo,'.claude'));
    await fs.symlink('../mode.txt',join(repo,'.claude/skills'));
    git(['add','.']);commit();git(['update-ref','refs/remotes/origin/main','HEAD']);
    await expect(remote.buildManifest({cwd:repo,exec})).rejects.toMatchObject({code:'unshipped-symlink'});
    await expect(remote.buildDeltaManifest({cwd:repo,exec,base})).rejects.toMatchObject({code:'unshipped-symlink'});
  });
  it('prefers the newest local ancestor over a newer nonancestor base',async()=>{
    const base=await baseFixture();
    await fs.writeFile(join(repo,'mode.txt'),'next');git(['add','.']);commit();
    const newerAncestor=await baseFixture();
    git(['checkout','--orphan','other']);await fs.writeFile(join(repo,'other.txt'),'other');git(['add','.']);commit();
    const nonancestor=await baseFixture();
    git(['checkout','--detach',newerAncestor.sha]);
    expect(await remote.selectBase({cwd:repo,exec,bases:[{...base,sha:'a'.repeat(40)},nonancestor,newerAncestor,base]})).toEqual(newerAncestor);
  });
  it('uses the newest locally available nonancestor: integrity comes from the byte manifest, not ancestry',async()=>{
    const older=await baseFixture();
    await fs.writeFile(join(repo,'mode.txt'),'new base');git(['add','.']);commit();
    const base=await baseFixture();
    git(['checkout','--orphan','other']);await fs.writeFile(join(repo,'other.txt'),'other');git(['add','.']);commit();
    await fs.writeFile(join(repo,'mode.txt'),'different bytes');await fs.rm(join(repo,'deleted.txt'));await fs.chmod(join(repo,'a.test.mjs'),0o755);
    const selected=await remote.selectBase({cwd:repo,exec,bases:[{...base,sha:'a'.repeat(40)},base,older]});
    expect(selected).toEqual(base);
    const delta=await remote.buildDeltaManifest({cwd:repo,exec,base:selected});
    const full=await remote.buildManifest({cwd:repo,exec});
    expect(manifestWire(delta)).toEqual(manifestWire(full));
    expect(delta.manifestDigest).toBe(full.manifestDigest);
    expect(delta.deltaPaths.map(p=>p.toString())).toEqual(['a.test.mjs','mode.txt','other.txt']);
    expect(delta.deletions.map(p=>p.toString())).toEqual(['deleted.txt']);
  });
  it('ranks twelve advertised bases by ancestor distance rather than advertisement order and rejects thirteen',async()=>{
    const older=await baseFixture();
    await fs.writeFile(join(repo,'mode.txt'),'next');git(['add','.']);commit();
    const nearest=await baseFixture();
    const bases=[older,...Array.from({length:10},(_,i)=>({...older,sha:i.toString(16).repeat(40)})),nearest];
    expect(BASE_RETENTION).toBe(12);
    expect(await remote.selectBase({cwd:repo,exec,bases})).toEqual(nearest);
    expect(await remote.selectBase({cwd:repo,exec,bases:[...bases,older]})).toBeNull();
  });
  it('prefers fewer changed paths for nonancestors and safely retains newest order on missing distance',async()=>{
    const bases=Array.from({length:3},(_,i)=>({sha:String(i).repeat(40),manifestDigest:'a'.repeat(64)}));
    const probe=vi.fn(async call=>bindingEvidence(call)??(({args})=>({code:args[0]==='merge-base'?1:0,stdout:args[0]==='diff'?Buffer.from(args.includes(bases[1].sha)?'a\0':'a\0b\0'):Buffer.alloc(0)}))({args:gitArgs(call)}));
    expect(await remote.selectBase({cwd:repo,exec:probe,bases})).toEqual(bases[1]);
    expect(probe.mock.calls.filter(([call])=>!call.args.includes('--show-toplevel')).length).toBeLessThanOrEqual(4*bases.length);
    const broken=async call=>gitArgs(call)[0]==='diff'?{code:1,stdout:Buffer.alloc(0)}:probe(call);
    expect(await remote.selectBase({cwd:repo,exec:broken,bases})).toEqual(bases[0]);
  });
  it('uses full shipping when no ready base exists locally',async()=>{
    const base=await baseFixture();
    expect(await remote.selectBase({cwd:repo,exec,bases:[{...base,sha:'a'.repeat(40)}]})).toBeNull();
    expect(await remote.selectBase({cwd:repo,exec,bases:[]})).toBeNull();
  });
  it.each([1,2,3])('delta overlay equals a full manifest with additions, deletions, modes and public credentials (case %s)',async seed=>{
    const base=await baseFixture();
    await fs.writeFile(join(repo,'a.test.mjs'),'changed '+seed);await fs.rm(join(repo,'deleted.txt'));await fs.chmod(join(repo,'mode.txt'),0o755);
    await fs.writeFile(join(repo,'added.txt'),'added '+seed);git(['add','.']);commit();
    await fs.writeFile(join(repo,'untracked.txt'),'untracked '+seed);await fs.writeFile(join(repo,'credentials.txt'),'still private');
    const delta=await remote.buildDeltaManifest({cwd:repo,exec,base});
    const full=await remote.buildManifest({cwd:repo,exec});
    expect(delta.manifestDigest).toBe(full.manifestDigest);
    expect(manifestWire(delta)).toEqual(manifestWire(full));
    expect(delta.deltaPaths.map(p=>p.toString())).toEqual(['a.test.mjs','added.txt','mode.txt','untracked.txt']);
    expect(delta.deletions.map(p=>p.toString())).toEqual(['deleted.txt']);
    expect(delta.entries.some(e=>e.path.toString()==='oauth-source.mjs')).toBe(true);
    expect(delta.excluded.map(p=>p.toString())).toContain('credentials.txt');
  });
  it('refuses a credential source changed from public evidence and ignored tests in delta mode',async()=>{
    const base=await baseFixture();await fs.writeFile(join(repo,'oauth-source.mjs'),'private bytes');
    await expect(remote.buildDeltaManifest({cwd:repo,exec,base})).rejects.toThrow('Excluded source');
    git(['checkout','--','oauth-source.mjs']);await fs.writeFile(join(repo,'.gitignore'),'ignored.test.mjs\n');await fs.writeFile(join(repo,'ignored.test.mjs'),'hidden');
    await expect(remote.buildDeltaManifest({cwd:repo,exec,base})).rejects.toThrow('Ignored test');
  });
  it('reuses clean leaves while hashing changed and public credential paths',async()=>{
    const base=await baseFixture();await fs.writeFile(join(repo,'a.test.mjs'),'changed');
    const read=vi.fn(path=>fs.readFile(path));
    const delta=await remote.buildDeltaManifest({cwd:repo,exec,base,fs:{...fs,readFile:read}});
    expect(delta.deltaPaths.map(p=>p.toString())).toEqual(['a.test.mjs']);
    expect(delta.manifestMode).toBe('git-delta');
    expect(read.mock.calls.map(([path])=>Buffer.from(path).subarray(Buffer.byteLength(repo)+1).toString()).sort()).toEqual(['a.test.mjs','oauth-source.mjs']);
  });
  it('reads and hashes every final leaf when the fast path is unavailable',async()=>{
    const base=await baseFixture();
    await fs.writeFile(join(repo,'a.test.mjs'),'changed');await fs.rm(join(repo,'deleted.txt'));
    await fs.writeFile(join(repo,'untracked.txt'),'new');
    const read=vi.fn(path=>fs.readFile(path));
    const unavailable=call=>gitArgs(call)[0]==='diff'&&call.args.includes('--name-only')?Promise.resolve({code:1,stdout:Buffer.alloc(0)}):exec(call);
    const delta=await remote.buildDeltaManifest({cwd:repo,exec:unavailable,base,fs:{...fs,readFile:read}});
    const full=await remote.buildManifest({cwd:repo,exec});
    expect(delta.manifestMode).toBe('full-scan');
    expect(delta.manifestReason).toBeTruthy();
    expect(delta.entries).toEqual(full.entries);
    expect(delta.manifestDigest).toBe(full.manifestDigest);
    const reads=new Map(read.mock.calls.map(([path],i)=>[Buffer.from(path).subarray(Buffer.byteLength(repo)+1).toString(),read.mock.results[i].value]));
    for(const entry of delta.entries) {
      expect(reads.has(entry.path.toString())).toBe(true);
      expect(entry.sha256).toBe(hash(await reads.get(entry.path.toString())));
    }
  });
  it('includes autocrlf worktree bytes that git considers clean and matches full shipping',async()=>{
    await fs.writeFile(join(repo,'mode.txt'),'line\n');git(['add','.']);commit();
    const base=await baseFixture();git(['config','core.autocrlf','true']);
    await fs.writeFile(join(repo,'mode.txt'),'line\r\n');
    expect(git(['diff','--name-only'])).toHaveLength(0);
    const delta=await remote.buildDeltaManifest({cwd:repo,exec,base});
    expect(delta.deltaPaths.map(p=>p.toString())).toEqual(['mode.txt']);
    expect(delta.manifestDigest).toBe((await remote.buildManifest({cwd:repo,exec})).manifestDigest);
  });
  it.each(['bytes','executable'])('detects a git-clean %s change racing after diff evidence',async fault=>{
    const base=await baseFixture();let raced=false;
    const racingExec=async call=>{
      const result=await exec(call);
      if(!raced&&gitArgs(call)[0]==='diff'&&call.args.at(-2)==='HEAD') {
        raced=true;
        if(fault==='bytes')await fs.writeFile(join(repo,'mode.txt'),'race');
        else await fs.chmod(join(repo,'mode.txt'),0o755);
      }
      return result;
    };
    const delta=await remote.buildDeltaManifest({cwd:repo,exec:racingExec,base});
    expect(delta.deltaPaths.map(p=>p.toString())).toEqual(['mode.txt']);
    expect(delta.manifestDigest).toBe((await remote.buildManifest({cwd:repo,exec})).manifestDigest);
  });

});

describe('runner base materialization refuses before install',()=>{
  async function setup(pool=false,shape,linked=false) {
    if(shape==='file to directory')await fs.writeFile(join(repo,'node'),'old leaf');
    if(['directory to file','nested deletion'].includes(shape)) {
      await fs.mkdir(join(repo,'node','nested'),{recursive:true});await fs.writeFile(join(repo,'node','nested','leaf'),'old leaf');
    }
    const base=await baseFixture();const server=join(root,'server');const dir=join(server,'bases',base.sha);await fs.mkdir(join(dir,'tree'),{recursive:true});
    const copy=async(source,dest)=>{await fs.mkdir(dirname(dest),{recursive:true});await fs.copyFile(source,dest);};
    for(const path of Buffer.from(base.manifest.paths,'base64').toString().split('\0').filter(Boolean)) await copy(join(repo,path),join(dir,'tree',path));
    await fs.writeFile(join(dir,'manifest.json'),JSON.stringify(base.manifest));await fs.writeFile(join(dir,'READY'),JSON.stringify({sha:base.sha,manifestDigest:base.manifestDigest,lockDigest:hash('lock'),readyAtMs:1,fetchedAtMs:0}));
    const bin=join(server,'bin');await fs.mkdir(bin);await fs.symlink(process.execPath,join(bin,'node'));
    await fs.writeFile(join(bin,'npm'),`#!/bin/sh\necho ran >> '${server}/npm.log'\necho \"$*\" >> '${server}/npm-args.log'\nexit 0\n`,{mode:0o755});
    if(pool){await fs.mkdir(join(server,'runs','slot-1'),{recursive:true,mode:0o710});await fs.chmod(join(server,'runs','slot-1'),0o710);}
    const workerExec=vi.fn(async()=>({code:0,stdout:'',stderr:''}));
    const runner=createRunner({testRoot:server,testPath:bin+':/usr/bin:/bin',...(pool?{testWorkerExec:workerExec}:{})});
    const nonce='e'.repeat(32),prepared=await runner.prepare({nonce});
    expect(prepared.capabilities).toMatchObject({delta:1,bases:[{sha:base.sha,manifestDigest:base.manifestDigest}]});
    await fs.writeFile(join(repo,'a.test.mjs'),'changed');await fs.rm(join(repo,'deleted.txt'));
    if(linked) {
      await fs.mkdir(join(repo,'skills-src'));await fs.writeFile(join(repo,'skills-src/leaf.md'),'skill');
      await fs.mkdir(join(repo,'.claude'));await fs.symlink('../skills-src',join(repo,'.claude/skills'));
      git(['add','skills-src','.claude/skills']);
    }
    if(shape)await fs.rm(join(repo,'node'),{recursive:true});
    if(shape==='file to directory'){await fs.mkdir(join(repo,'node'));await fs.writeFile(join(repo,'node','leaf'),'new leaf');}
    if(shape==='directory to file')await fs.writeFile(join(repo,'node'),'new leaf');
    const manifest=await remote.buildManifest({cwd:repo,exec});
    const work=join(server,'runs',...(pool?['slot-1']:[]),prepared.run,'work');await fs.copyFile(join(repo,'a.test.mjs'),join(work,'a.test.mjs'));
    if(shape==='file to directory')await copy(join(repo,'node','leaf'),join(work,'node','leaf'));
    if(shape==='directory to file')await copy(join(repo,'node'),join(work,'node'));
    // Real fully materialized local tree supplies the unchanged legacy input binding.
    const full=join(root,'full');await fs.mkdir(full);
    for(const entry of manifest.entries)await copy(join(repo,entry.path.toString()),join(full,entry.path.toString()));
    const argv=['npm','run','test:unit','--','a.test.mjs'];
    const request={v:1,nonce,run:prepared.run,argv,env:{},argvDigest:digestArgv(argv),lock:hash('lock'),inputDigest:await digestInput(full),manifest:manifestWire(manifest),manifestDigest:manifest.manifestDigest,baseSha:base.sha,baseManifestDigest:base.manifestDigest,deletions:Buffer.from('deleted.txt\0').toString('base64')};
    if(shape)request.deletions=Buffer.concat([Buffer.from('deleted.txt\0'),Buffer.from(shape==='file to directory'?'node\0':'node/nested/leaf\0')]).toString('base64');
    return {base,dir,server,runner,request,work,workerExec};
  }
  it('uses independent copies, applies deletion and delta, and verifies before install',async()=>{
    const f=await setup();expect((await f.runner.run(f.request)).code).toBe(0);
    expect(await fs.readFile(join(f.work,'a.test.mjs'),'utf8')).toBe('changed');
    await expect(fs.stat(join(f.work,'deleted.txt'))).rejects.toMatchObject({code:'ENOENT'});
    await fs.writeFile(join(f.work,'mode.txt'),'worker modification');expect(await fs.readFile(join(f.dir,'tree/mode.txt'),'utf8')).toBe('mode');
    expect((await f.runner.telemetry()).recent.find(r=>r.runId===f.request.run).prewarmed).toBe(false);
    const receipt=await f.runner.finish(f.request);expect(receipt.timings).toMatchObject({installMs:expect.any(Number),runMs:expect.any(Number)});
  });
  it.each(['valid','tampered','absent','symlink','bad marker','not private','writable pool','writable parent','writable marker','linked marker','symlink marker'])('prewarm %s claims exclusively or falls back to the ordinary copy, applying only delta',async kind=>{
    const f=await setup(true),parent=join(f.server,'bases','prewarm',f.base.sha),tree=join(parent,'1');
    if(kind!=='absent') {
      await fs.mkdir(parent,{recursive:true,mode:0o700});await fs.mkdir(tree,{mode:0o700});
      const {decodeManifest}=await import('../forge-exec-manifest.mjs');
      await copyLeaves(join(f.dir,'tree'),tree,decodeManifest(f.base.manifest).entries);
      await fs.writeFile(tree+'.json',JSON.stringify({sha:f.base.sha,manifestDigest:f.base.manifestDigest}),{mode:0o600});
      if(kind==='tampered')await fs.writeFile(join(tree,'mode.txt'),'evil');
      if(kind==='symlink'){await fs.rm(join(tree,'mode.txt'));await fs.symlink(join(repo,'mode.txt'),join(tree,'mode.txt'));}
      if(kind==='not private')await fs.chmod(tree,0o755);
      if(kind==='bad marker')await fs.writeFile(tree+'.json','{}');
      if(kind==='writable pool')await fs.chmod(dirname(parent),0o720);
      if(kind==='writable parent')await fs.chmod(parent,0o702);
      if(kind==='writable marker')await fs.chmod(tree+'.json',0o620);
      if(kind==='linked marker')await fs.link(tree+'.json',join(root,'marker-link'));
      if(kind==='symlink marker'){await fs.rename(tree+'.json',join(root,'marker-target'));await fs.symlink(join(root,'marker-target'),tree+'.json');}
    }
    const inode=kind==='valid'?(await fs.stat(join(tree,'mode.txt'))).ino:null;
    expect((await f.runner.run(f.request)).code).toBe(0);
    expect(await fs.readFile(join(f.work,'a.test.mjs'),'utf8')).toBe('changed');
    expect(await fs.readFile(join(f.work,'mode.txt'),'utf8')).toBe('mode');
    await expect(fs.lstat(join(f.work,'deleted.txt'))).rejects.toMatchObject({code:'ENOENT'});
    if(kind==='valid') {
      expect((await fs.stat(join(f.work,'mode.txt'))).ino).toBe(inode);
      await expect(fs.lstat(tree)).rejects.toMatchObject({code:'ENOENT'});
      expect(await claimPrewarm(join(f.server,'bases'),f.base.sha,'1',join(parent,'second'),f.base.manifest,f.base.manifestDigest,()=>{})).toBe(false);
    }
    expect((await f.runner.telemetry()).recent.find(r=>r.runId===f.request.run).prewarmed).toBe(kind==='valid');
    if(['writable pool','writable parent','writable marker','linked marker','symlink marker'].includes(kind))expect(await fs.lstat(tree)).toBeDefined();
    await f.runner.finish(f.request);
  });
  it.each(['uid argument','pool owner','parent owner','tree owner','marker owner'])('rejects untrusted prewarm %s before claim and leaves ordinary copying available',async kind=>{
    const f=await setup(true),bases=join(f.server,'bases'),pool=join(bases,'prewarm'),parent=join(pool,f.base.sha),tree=join(parent,'1');
    const {decodeManifest}=await import('../forge-exec-manifest.mjs');
    await fs.mkdir(tree,{recursive:true,mode:0o700});
    await copyLeaves(join(f.dir,'tree'),tree,decodeManifest(f.base.manifest).entries);
    await fs.writeFile(tree+'.json',JSON.stringify({sha:f.base.sha,manifestDigest:f.base.manifestDigest}),{mode:0o600});
    const suspect={'pool owner':pool,'parent owner':parent,'tree owner':tree,'marker owner':tree+'.json'}[kind];
    const io={...fs,lstat:async path=>{
      const st=await fs.lstat(path);if(String(path)===suspect)st.uid=process.getuid()+1;return st;
    }};
    const dest=join(root,'claimed'),verify=vi.fn(),inode=(await fs.lstat(tree)).ino;
    expect(await claimPrewarm(bases,f.base.sha,'1',dest,f.base.manifest,f.base.manifestDigest,verify,io,process.getuid()+(kind==='uid argument'?1:0))).toBe(false);
    expect(verify).not.toHaveBeenCalled();expect((await fs.lstat(tree)).ino).toBe(inode);
    await expect(fs.lstat(dest)).rejects.toMatchObject({code:'ENOENT'});
    await fs.mkdir(dest);await copyLeaves(join(f.dir,'tree'),dest,decodeManifest(f.base.manifest).entries);
    expect(await fs.readFile(join(dest,'mode.txt'),'utf8')).toBe('mode');
  });
  it.each(['file to directory','directory to file','nested deletion'])('prewarm applies %s without stale parent directories',async shape=>{
    const f=await setup(true,shape),tree=join(f.server,'bases','prewarm',f.base.sha,'1');
    await fs.mkdir(tree,{recursive:true,mode:0o700});
    const {decodeManifest}=await import('../forge-exec-manifest.mjs');
    await copyLeaves(join(f.dir,'tree'),tree,decodeManifest(f.base.manifest).entries);
    await fs.writeFile(tree+'.json',JSON.stringify({sha:f.base.sha,manifestDigest:f.base.manifestDigest}),{mode:0o600});
    const inode=(await fs.stat(join(tree,'mode.txt'))).ino;
    f.workerExec.mockImplementation(async({cwd})=>{
      // Observe exact reconstructed inputs before install/test consumers run.
      if(cwd===f.work) {
        expect(await digestInput(cwd)).toBe(f.request.inputDigest);
        expect(await fs.readFile(join(cwd,'a.test.mjs'),'utf8')).toBe('changed');
        expect((await fs.stat(join(cwd,'mode.txt'))).ino).toBe(inode);
        await expect(fs.lstat(join(cwd,'deleted.txt'))).rejects.toMatchObject({code:'ENOENT'});
        if(shape==='nested deletion')await expect(fs.lstat(join(cwd,'node'))).rejects.toMatchObject({code:'ENOENT'});
        else expect(await fs.readFile(join(cwd,'node',...(shape==='file to directory'?['leaf']:[])),'utf8')).toBe('new leaf');
      }
      return {code:0,stdout:'',stderr:''};
    });
    expect((await f.runner.run(f.request)).code).toBe(0);
    expect(f.workerExec.mock.calls.filter(([call])=>call.cwd===f.work).length).toBeGreaterThanOrEqual(2);
    expect((await fs.stat(join(f.work,'mode.txt'))).ino).toBe(inode);
    if(shape==='nested deletion')await expect(fs.lstat(join(f.work,'node'))).rejects.toMatchObject({code:'ENOENT'});
    else expect(await fs.readFile(join(f.work,'node',...(shape==='file to directory'?['leaf']:[])),'utf8')).toBe('new leaf');
    expect((await f.runner.telemetry()).recent.find(r=>r.runId===f.request.run).prewarmed).toBe(true);
    await f.runner.finish(f.request);
  });
  it.each(['base mutated','delta tamper','symlink delta','deletion traversal','unknown base','digest mismatch','unready base','malformed READY'])('rejects %s with protected non-start evidence and no npm',async fault=>{
    const f=await setup();
    if(fault==='base mutated')await fs.writeFile(join(f.dir,'tree/mode.txt'),'tamper');
    if(fault==='delta tamper')await fs.writeFile(join(f.work,'a.test.mjs'),'tamper');
    if(fault==='symlink delta'){await fs.rm(join(f.work,'a.test.mjs'));await fs.symlink(join(repo,'a.test.mjs'),join(f.work,'a.test.mjs'));}
    if(fault==='deletion traversal')f.request.deletions=Buffer.from('../escape\0').toString('base64');
    if(fault==='unknown base')f.request.baseSha='0'.repeat(40);
    if(fault==='digest mismatch')f.request.baseManifestDigest='0'.repeat(64);
    if(fault==='unready base')await fs.rm(join(f.dir,'READY'));
    if(fault==='malformed READY')await fs.writeFile(join(f.dir,'READY'),JSON.stringify({sha:f.base.sha,manifestDigest:f.base.manifestDigest}));
    await expect(f.runner.run(f.request)).rejects.toThrow();
    await expect(fs.stat(join(f.server,'npm.log'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await f.runner.finish(f.request)).toMatchObject({phase:'rejected',started:false,delta:true});
  });
  // These cases run real Git, file copies and the install supervisor; allow for CI contention.
  it.each(['delta','tracked symlink','retry succeeds','next base','fallback reason','old runner','manifest unavailable','oversized manifest','git failure','base blob failure','late delta failure','ignored listing failure','ignored listing rejection'])('remote transport uses %s, preserves the exact full manifest and reports prepared run IDs on initial execution and full retries',async mode=>{
    const f=await setup(false,undefined,mode==='tracked symlink'),requests=[],copies=[],log=vi.fn();
    const preparedRuns=[], notifiedRuns=[], transferNotifications=[];
    const sshOptions=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60s','-o','ControlPath=private-cm/%C'];
    let baseRetrieved=false,ignoredCalls=0,manifestCalls=0;
    const attempts=[];
    if(mode==='next base'){git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','next']);}
    const transport=async call=>{
      if(call.file==='git'&&call.args.includes('-i')) {
        ignoredCalls++;
        if(mode==='delta')expect(baseRetrieved).toBe(true);
        if(ignoredCalls===1&&mode==='ignored listing failure')return {code:1,stdout:Buffer.alloc(0)};
        if(ignoredCalls===1&&mode==='ignored listing rejection')throw new Error('ignore inventory unavailable');
      }
      if(call.file==='git'){if(mode==='git failure'&&gitArgs(call)[0]==='status')return {code:1,stdout:Buffer.alloc(0)};if(mode==='base blob failure'&&gitArgs(call)[0]==='cat-file'&&gitArgs(call)[1]==='blob')return {code:1,stdout:Buffer.alloc(0)};return exec(call);}
      if(call.file==='ssh')expect(call.sshOptions).toEqual(sshOptions);
      if(call.file==='rsync'){
        transferNotifications.push([...notifiedRuns]);
        expect(call.args[call.args.indexOf('-e')+1]).toBe(`ssh ${sshOptions.map(value=>`'${value}'`).join(' ')}`);
        copies.push(call.input);
        // Fail after manifest construction, then allow the full-ship retry.
        if(mode==='late delta failure'&&copies.length===1)return {code:1,stdout:Buffer.alloc(0)};
        const destination=call.args.at(-1).split(':').slice(1).join(':').replace('/srv/forge-exec',join(f.server,'runs'));
        for(const name of call.input.toString().split('\0').filter(Boolean)){const rel=name.slice(2);await fs.mkdir(join(destination,rel,'..'),{recursive:true});await fs.copyFile(join(call.cwd,rel),join(destination,rel));}
        return {code:0,stdout:Buffer.alloc(0)};
      }
      const action=call.args.at(-1).split(' ').at(-1);
      if(action==='true')return {code:0,stdout:''};
      if(action==='bases'&&mode==='old runner')return {code:254,stdout:''};
      if(action==='bases'&&mode==='next base')return {code:0,stdout:JSON.stringify({delta:1,bases:[{sha:git(['rev-parse','HEAD']).toString().trim(),manifestDigest:f.base.manifestDigest},f.base]})};
      if(action==='bases'&&mode==='fallback reason')throw new Error('discovery\n\x1b'+ 'x'.repeat(250));
      if(action==='base-manifest'){manifestCalls++;attempts.push(JSON.parse(call.input).sha);if(mode==='retry succeeds'&&manifestCalls===1||mode==='next base'&&manifestCalls<=2)return {code:254,stdout:''};}
      if(action==='base-manifest'&&mode==='manifest unavailable')return {code:254,stdout:''};
      if(action==='base-manifest'&&mode==='oversized manifest')return {code:0,stdout:'x'.repeat(4*1024*1024+1)};
      const value=await f.runner[action](JSON.parse(call.input));
      if(action==='prepare')preparedRuns.push(value.run);
      if(action==='base-manifest')baseRetrieved=true;
      if(action==='run'){requests.push(JSON.parse(call.input));return {code:value.code,stdout:''};}
      return {code:0,stdout:JSON.stringify(value)};
    };
    const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:transport,log,sshOptions,onRun:run=>notifiedRuns.push(run)});
    expect(preparedRuns).toHaveLength(mode==='late delta failure'?2:1);
    expect(notifiedRuns).toEqual(preparedRuns);
    expect(transferNotifications).toEqual(preparedRuns.map((_,i)=>preparedRuns.slice(0,i+1)));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(['delta','tracked symlink','retry succeeds','next base','late delta failure'].includes(mode)?/^manifest: git-delta \(\d+ changed of \d+\)\n$/:/^manifest: full-scan \(.+\)\n$/));
    expect(result.mode).toBe('remote');
    if(mode==='retry succeeds')expect(manifestCalls).toBe(2);
    if(mode==='next base'){expect(manifestCalls).toBe(3);expect(attempts[0]).toBe(attempts[1]);expect(attempts[2]).toBe(f.base.sha);}
    if(mode==='fallback reason'){const reason=result.timings.find(s=>s.stage==='manifest-build').manifestReason;expect(reason).toHaveLength(200);expect(reason).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);expect(log).toHaveBeenCalledWith(`manifest: full-scan (${reason})\n`);}
    if(mode.startsWith('ignored listing'))expect(ignoredCalls).toBe(2);
    if(mode==='delta') {
      expect(ignoredCalls).toBe(1);
      const substages=result.timings.find(stage=>stage.stage==='manifest-build').substages;
      expect(substages.map(stage=>stage.stage).sort()).toEqual(['base-blob-verification','cross-check','git-evidence','hashing','ignored-file-listing','inventory-walk','lstat-pass']);
      expect(substages.every(stage=>Number.isFinite(stage.ms)&&stage.ms>=0)).toBe(true);
    }
    const stage=result.timings.filter(s=>s.stage==='rsync').at(-1);
    const deltaMode=['delta','tracked symlink','retry succeeds','next base'].includes(mode);
    expect(stage.shipMode).toBe(deltaMode?'delta':'full');
    // Independent fixture bytes: unchanged lock/mode/public source are reused
    // only in delta mode; the deleted file and private credentials never ship.
    const payloads=mode==='tracked symlink'?['changed','skill','skill']:deltaMode?['changed']:['changed','lock','mode','public'];
    const bytes=payloads.reduce((sum,content)=>sum+Buffer.byteLength(content),0);
    expect(stage).toMatchObject({fileCount:payloads.length,bytesSent:bytes,
      deltaFileCount:deltaMode?payloads.length:0,deltaBytes:deltaMode?bytes:0});
    expect(requests[0].manifestDigest).toBe(f.request.manifestDigest);
    if(mode==='late delta failure'){
      expect(log).toHaveBeenCalledWith('manifest: full-scan (Full ship selected)\n');
      expect(copies).toHaveLength(2);
      expect(copies[0]).toEqual(Buffer.from('./a.test.mjs\0'));
    }
    if(mode==='delta'){
      expect(copies[0]).toEqual(Buffer.from('./a.test.mjs\0'));
      expect(requests[0]).toMatchObject({baseSha:f.base.sha,deletions:Buffer.from('deleted.txt\0').toString('base64')});
    }else if(mode==='tracked symlink') {
      expect(result.code).toBe(0);
      expect(copies[0]).toEqual(Buffer.from('./.claude/skills/leaf.md\0./a.test.mjs\0./skills-src/leaf.md\0'));
      expect(requests[0].baseSha).toBe(f.base.sha);
    }else if(!['retry succeeds','next base'].includes(mode))expect(requests[0].baseSha).toBeUndefined();
  },30_000);
  it('refuses an ignored test created while the SSH base-manifest response is in flight',async()=>{
    const f=await setup(),ignoredListings=[];
    await fs.writeFile(join(repo,'.git/info/exclude'),'late.test.mjs\n');
    const transport=vi.fn(async call=>{
      if(call.file==='git') {
        const result=await exec(call);
        if(call.args.includes('-i'))ignoredListings.push(result.stdout);
        return result;
      }
      if(call.file!=='ssh')throw new Error('Unexpected transport before admission');
      const action=call.args.at(-1).split(' ').at(-1);
      if(action==='true')return {code:0,stdout:''};
      if(!['bases','base-manifest'].includes(action))throw new Error('Unexpected remote preparation before admission');
      const value=await f.runner[action](JSON.parse(call.input));
      if(action==='base-manifest') {
        // Let any speculative listing finish before the ignored file appears.
        await new Promise(resolve=>setImmediate(resolve));
        await fs.writeFile(join(repo,'late.test.mjs'),'hidden test');
      }
      return {code:0,stdout:JSON.stringify(value)};
    });
    const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:transport,log:vi.fn()});
    expect(result).toMatchObject({mode:'not-started',terminated:true,reason:'ignored-test-file'});
    expect(transport.mock.calls.some(([call])=>call.file==='ssh'&&call.args.at(-1).endsWith(' base-manifest'))).toBe(true);
    expect(ignoredListings.length).toBeGreaterThan(0);
    for(const listing of ignoredListings)expect(listing.toString().split('\0')).toContain('late.test.mjs');
    expect(transport.mock.calls.some(([call])=>call.file==='rsync'||call.file==='ssh'&&/ (prepare|run)$/.test(call.args.at(-1)))).toBe(false);
  });
  it.each(['corrupt base','missing base','unbound rejection','started rejection','missing finish','second rejection','lost run response','started run response'])('reports prepared run IDs on initial execution and full retries, retrying only a proven pre-start delta rejection once: %s',async fault=>{
    const f=await setup(),requests=[],prepares=[],finishes=[],copies=[];
    const preparedRuns=[], notifiedRuns=[], transferNotifications=[];
    const transport=async call=>{
      if(call.file==='git')return exec(call);
      if(call.file==='rsync') {
        transferNotifications.push([...notifiedRuns]);
        copies.push(call.input);
        const destination=call.args.at(-1).split(':').slice(1).join(':').replace('/srv/forge-exec',join(f.server,'runs'));
        for(const name of call.input.toString().split('\0').filter(Boolean)){const rel=name.slice(2);await fs.mkdir(join(destination,rel,'..'),{recursive:true});await fs.copyFile(join(call.cwd,rel),join(destination,rel));}
        return {code:0,stdout:''};
      }
      const action=call.args.at(-1).split(' ').at(-1);
      if(action==='true')return {code:0,stdout:''};
      const request=JSON.parse(call.input);
      if(action==='prepare')prepares.push(request);
      if(action==='run') {
        requests.push(request);
        if(requests.length===1 && fault!=='started run response') {
          if(fault==='missing base')await fs.rm(join(f.dir,'READY'));
          else await fs.writeFile(join(f.dir,'tree/mode.txt'),'corrupt');
        } else if(fault==='second rejection')await fs.writeFile(join(f.server,'runs',request.run,'work/a.test.mjs'),'corrupt');
        let value;
        try {value=await f.runner.run(request);}
        catch{if(fault==='lost run response')throw new Error('SSH response lost');return {code:1,stdout:''};}
        if(fault==='started run response')throw new Error('SSH response lost after execution');
        return {code:value.code,stdout:''};
      }
      let value=await f.runner[action](request);
      if(action==='prepare')preparedRuns.push(value.run);
      if(action==='finish') {
        finishes.push(request);
        if(fault==='missing finish')return {code:1,stdout:''};
        if(fault==='unbound rejection')value.nonce='0'.repeat(32);
        if(fault==='started rejection')value.started=true;
        if(fault==='second rejection'&&requests.length===2)value={v:1,...request,phase:'rejected',reason:'snapshot-rejected',siblings:true,started:false};
      }
      return {code:0,stdout:JSON.stringify(value)};
    };
    const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:transport,onRun:run=>notifiedRuns.push(run)});
    const retry=['corrupt base','missing base','second rejection','lost run response'].includes(fault);
    expect(requests).toHaveLength(retry?2:1);
    expect(prepares).toHaveLength(retry?2:1);
    expect(notifiedRuns).toEqual(preparedRuns);
    expect(preparedRuns).toEqual(requests.map(request=>request.run));
    expect(transferNotifications).toEqual(preparedRuns.map((_,i)=>preparedRuns.slice(0,i+1)));
    expect(finishes).toHaveLength(retry?2:1);
    if(retry) {
      expect(requests[0].baseSha).toBe(f.base.sha);
      expect(requests[1].baseSha).toBeUndefined();
      expect(requests[1].run).not.toBe(requests[0].run);
      expect(requests[1].nonce).not.toBe(requests[0].nonce);
      expect(copies[1].toString()).toContain('./mode.txt\0');
      expect(requests[1].manifestDigest).toBe(f.request.manifestDigest);
      expect(result.timings.filter(t=>t.stage==='rsync').every(t=>t.shipMode==='delta-then-full')).toBe(true);
      expect(result.timings.filter(t=>t.stage==='forge-run')).toHaveLength(2);
      const stages=result.timings.map(t=>t.stage);
      if(fault!=='second rejection')expect(stages.lastIndexOf('forge-install')).toBeGreaterThan(stages.lastIndexOf('rsync'));
    }
    expect(result.mode).toBe(fault==='second rejection'?'not-started':retry?'remote':'unconfirmed');
  },30_000); // A proven pre-start rejection performs a second complete transport/run/finish cycle.

  it('warmer reuses registry-only install inputs across nondependency main changes, while retaining full profile keys',async()=>{
    const f=await setup();
    const packageData=JSON.stringify({name:'fixture',version:'1.0.0'});
    const lockData=JSON.stringify({lockfileVersion:3,packages:{'':{name:'fixture'}}});
    await fs.writeFile(join(repo,'package-lock.json'),lockData);
    await fs.writeFile(join(repo,'package.json'),packageData);git(['add','.']);commit();
    const first=manifestWire(await remote.buildManifest({cwd:repo,exec}));
    await f.runner.warmInstall(repo,first);
    await fs.writeFile(join(repo,'a.test.mjs'),'new main test');
    const second=manifestWire(await remote.buildManifest({cwd:repo,exec}));
    await f.runner.warmInstall(repo,second);
    expect((await fs.readFile(join(f.server,'npm.log'),'utf8')).trim().split('\n')).toHaveLength(1);
    const profiles=await fs.readdir(join(f.server,'cache',hash(lockData)));
    expect(profiles.filter(p=>p.startsWith('dev-v5-'))).toHaveLength(2);
    await fs.writeFile(join(repo,'package.json'),JSON.stringify({name:'fixture',version:'2.0.0'}));
    await f.runner.warmInstall(repo,manifestWire(await remote.buildManifest({cwd:repo,exec})));
    expect((await fs.readFile(join(f.server,'npm.log'),'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it.each([
    ['registry-only control',()=>{}],
    ['workspaces',pkg=>{pkg.workspaces=['packages/*'];}],
    ...['file:./local','file:./local.tgz','link:./local','workspace:*'].map(spec=>[
      spec+' dependency',pkg=>{pkg.dependencies={fixture:spec};},
    ]),
    ...[2,4].map(version=>['unknown lock format '+version,(_pkg,lock)=>{lock.lockfileVersion=version;}]),
    ['missing package inventory',(_pkg,lock)=>{delete lock.packages;}],
    ['non-object package inventory',(_pkg,lock)=>{lock.packages='unknown';}],
    ['null package evidence',(_pkg,lock)=>{lock.packages['node_modules/fixture']=null;}],
    ['linked package',(_pkg,lock)=>{lock.packages['node_modules/fixture'].link=true;}],
    ['non-HTTPS resolution',(_pkg,lock)=>{lock.packages['node_modules/fixture'].resolved='http://registry.npmjs.org/fixture.tgz';}],
    ['missing integrity',(_pkg,lock)=>{delete lock.packages['node_modules/fixture'].integrity;}],
    ['non-string integrity',(_pkg,lock)=>{lock.packages['node_modules/fixture'].integrity=42;}],
    ['empty integrity',(_pkg,lock)=>{lock.packages['node_modules/fixture'].integrity='';}],
  ])('checks warm-profile reuse with available evidence for %s',async(fault,change)=>{
      const reusable=fault==='registry-only control';
      const f=await setup(),pkg={name:'fixture',version:'1.0.0'},lock={lockfileVersion:3,packages:{
        '':{name:'fixture'},
        'node_modules/fixture':{version:'1.0.0',resolved:'https://registry.npmjs.org/fixture.tgz',integrity:'sha512-fixture'},
      }};
      change(pkg,lock);
      const packageData=JSON.stringify(pkg);await fs.writeFile(join(repo,'package.json'),packageData);
      const lockData=JSON.stringify(lock);await fs.writeFile(join(repo,'package-lock.json'),lockData);
      // The fixture installer materializes observable dependency contents, so
      // incorrectly extracting the first archive cannot look like a full install.
      await fs.writeFile(join(f.server,'bin/npm'),String.raw`#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(join(f.server,'npm.log'))},'install\n');
fs.mkdirSync('node_modules/fixture',{recursive:true});
fs.copyFileSync('a.test.mjs','node_modules/fixture/value');
`,{mode:0o755});
      await fs.writeFile(join(repo,'a.test.mjs'),'dependency-one');
      await f.runner.warmInstall(repo,manifestWire(await remote.buildManifest({cwd:repo,exec})));
      const parent=join(f.server,'cache',hash(lockData));
      const profiles=(await fs.readdir(parent)).filter(n=>n.startsWith('dev-v5-'));
      expect(profiles).toHaveLength(1);
      const profile=profiles[0].slice('dev-v5-'.length);
      const archiveDigest=hash(await fs.readFile(join(parent,profiles[0],'dependencies.tar')));
      expect(await fs.readFile(join(parent,profiles[0],'sha256'),'utf8')).toBe(archiveDigest);
      // Seed the exact index that accepting these inputs would look up. Merely
      // leaving a full profile cannot test refusal: unsupported inputs publish
      // no index. The registry-only row proves this key and archive are usable.
      const signature=hash(JSON.stringify({lock:hash(lockData),
        packages:[[Buffer.from('package.json').toString('base64'),hash(packageData),false]],
        node:process.version,platform:process.platform,arch:process.arch,
        install:['ci','--include=dev','--ignore-scripts','--no-audit','--no-fund']}));
      const index=join(parent,'.warm-inputs-'+signature),evidence={profile,archiveDigest};
      if(reusable)expect(JSON.parse(await fs.readFile(index,'utf8'))).toEqual(evidence);
      else {
        await expect(fs.stat(index)).rejects.toMatchObject({code:'ENOENT'});
        await fs.writeFile(index,JSON.stringify(evidence),{flag:'wx',mode:0o600});
      }
      await fs.writeFile(join(repo,'a.test.mjs'),'dependency-two');
      await f.runner.warmInstall(repo,manifestWire(await remote.buildManifest({cwd:repo,exec})));
      expect((await fs.readFile(join(f.server,'npm.log'),'utf8')).trim().split('\n')).toHaveLength(reusable?1:2);
      expect(JSON.parse(await fs.readFile(index,'utf8'))).toEqual(evidence);
      const values=[];
      for(const profile of (await fs.readdir(parent)).filter(n=>n.startsWith('dev-v5-'))) {
        const extracted=await fs.mkdtemp(join(root,'dependencies-'));
        const result=await exec({file:'/usr/bin/tar',args:['-xf',join(parent,profile,'dependencies.tar'),'-C',extracted]});
        expect(result.code).toBe(0);values.push(await fs.readFile(join(extracted,'node_modules/fixture/value'),'utf8'));
      }
      expect(values.sort()).toEqual(reusable?['dependency-one','dependency-one']:['dependency-one','dependency-two']);
    },30_000);

  it('seeds a full sibling-bound profile from proven registry-only warm inputs, never a lock-only key',async()=>{
    const f=await setup();
    await fs.writeFile(join(repo,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
    const lockData=JSON.stringify({lockfileVersion:3,packages:{'':{name:'fixture'}}});await fs.writeFile(join(repo,'package-lock.json'),lockData);
    git(['add','.']);commit();
    const manifest=manifestWire(await remote.buildManifest({cwd:repo,exec}));
    await f.runner.warmInstall(repo,manifest);
    const prepared=await f.runner.prepare({nonce:f.request.nonce,siblings:true});
    const work=join(f.server,'runs',prepared.run,'work');
    const primary=await remote.buildManifest({cwd:repo,exec});
    for(const e of primary.entries)await fs.copyFile(join(repo,e.path.toString()),join(work,e.path.toString()));
    const sibling=join(f.server,'runs',prepared.run,'frontierui');await fs.mkdir(join(sibling,'plugs'));await fs.writeFile(join(sibling,'plugs/index.js'),'private sibling');
    manifest.siblings={frontierui:{sha:'a'.repeat(40),...manifestWire({entries:[{path:Buffer.from('plugs/index.js'),sha256:hash('private sibling'),executable:false}],excluded:[]})}};
    const manifestDigest=digestManifest(manifest);
    const request={...f.request,run:prepared.run,manifest,manifestDigest,siblingShas:{frontierui:'a'.repeat(40)},lock:hash(lockData),inputDigest:await digestInput(work)};
    delete request.baseSha;delete request.baseManifestDigest;delete request.deletions;
    expect((await f.runner.run(request)).code).toBe(0);
    const commands=(await fs.readFile(join(f.server,'npm-args.log'),'utf8')).trim().split('\n');
    expect(commands.filter(line=>line.startsWith('ci')&&!line.includes('--dry-run'))).toHaveLength(1);
    expect(commands.some(line=>line.includes('--dry-run --offline'))).toBe(true);
    expect(await fs.stat(join(f.server,'cache',hash(lockData),'dev-v5-'+manifestDigest,'dependencies.tar'))).toBeDefined();
    await f.runner.finish(request);
  });

  // Card 7515: presync ships delta leaves ahead of the run; the run offers them
  // only as an rsync --copy-dest basis, and Forge still verifies every byte.
  describe('presync',()=>{
    const gitDir=()=>join(repo,'.git');
    // Fake transport around the real runner: presync rsync mirrors the stage
    // into a local cache dir; run rsync honours --copy-dest like real rsync,
    // or plants wrong bytes when tamper is set.
    function presyncTransport(f,{tamper=false,presyncCopyCode=0,mkdirCode=0}={}) {
      const calls=[],cacheRoot=join(f.server,'presync');
      const transport=vi.fn(async call=>{
        calls.push(call);
        if(call.file==='git')return exec(call);
        if(call.file==='rsync') {
          const target=call.args.at(-1).split(':').slice(1).join(':');
          if(target.startsWith('/srv/forge-exec/presync/')) {
            if(presyncCopyCode)return {code:presyncCopyCode,stdout:Buffer.alloc(0)};
            const dest=target.replace('/srv/forge-exec/presync',cacheRoot);
            await fs.rm(dest,{recursive:true,force:true});await fs.cp(call.cwd,dest,{recursive:true});
            return {code:0,stdout:Buffer.alloc(0)};
          }
          const copyDest=call.args.find(arg=>arg.startsWith('--copy-dest='))?.slice(12).replace('/srv/forge-exec/presync',cacheRoot);
          const destination=target.replace('/srv/forge-exec',join(f.server,'runs'));
          for(const name of call.input.toString().split('\0').filter(Boolean)){
            const rel=name.slice(2),out=join(destination,rel);await fs.mkdir(join(out,'..'),{recursive:true});
            const cached=copyDest&&await fs.readFile(join(copyDest,rel)).catch(()=>null);
            if(cached&&tamper)await fs.writeFile(out,'tamper');
            else if(cached&&cached.equals(await fs.readFile(join(call.cwd,rel))))await fs.writeFile(out,cached);
            else await fs.copyFile(join(call.cwd,rel),out);
          }
          return {code:0,stdout:Buffer.alloc(0)};
        }
        const command=call.args.at(-1);
        if(command.includes('mkdir -p -m 0711 /srv/forge-exec/presync'))return {code:mkdirCode,stdout:''};
        const action=command.split(' ').at(-1);
        if(action==='true')return {code:0,stdout:''};
        const value=await f.runner[action](JSON.parse(call.input));
        if(action==='run')return {code:value.code,stdout:''};
        return {code:0,stdout:JSON.stringify(value)};
      });
      return {transport,calls,cacheRoot};
    }
    const runRsync=calls=>calls.filter(c=>c.file==='rsync'&&c.args.at(-1).includes('/work/'));
    const presyncRsync=calls=>calls.filter(c=>c.file==='rsync'&&c.args.at(-1).includes('/presync/'));
    it('ships only delta leaves with no env, then the run claims them as a checksum basis and verifies',async()=>{
      const f=await setup(),t=presyncTransport(f);
      const round=await remote.presync({cwd:repo,exec:t.transport,sshOptions:[],env:{GITHUB_TOKEN:'ghs_secret',ANTHROPIC_API_KEY:'sk-secret',PATH:process.env.PATH}});
      expect(round).toMatchObject({status:'synced',count:1,bytes:7});
      const state=await remote.readPresyncState(gitDir());
      expect(state.baseManifestDigest).toBe(f.base.manifestDigest);
      const [copy]=presyncRsync(t.calls);
      expect(copy.args).toEqual(expect.arrayContaining(['--no-links','--safe-links','--delete']));
      expect(copy.args.at(-1)).toBe(`forge:/srv/forge-exec/presync/${state.key}/`);
      // Only the changed public leaf is cached: no credentials, deletions or unchanged files.
      expect((await fs.readdir(join(t.cacheRoot,state.key))).sort()).toEqual(['a.test.mjs']);
      expect(((await fs.stat(join(t.cacheRoot,state.key))).mode&0o777)).toBe(0o711);
      for(const call of t.calls.filter(c=>c.file!=='git')) {
        expect(call.env).toBeUndefined();
        expect(JSON.stringify(call)).not.toMatch(/ghs_secret|sk-secret/);
      }
      const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]});
      expect(result).toMatchObject({mode:'remote',code:0});
      const [shipped]=runRsync(t.calls);
      expect(shipped.args).toEqual(expect.arrayContaining(['--checksum',`--copy-dest=/srv/forge-exec/presync/${state.key}/`,'--no-links','--safe-links','--no-recursive']));
      expect(result.timings.find(s=>s.stage==='rsync')).toMatchObject({shipMode:'delta',presyncClaimed:{count:1,bytes:7}});
    },30_000);
    it('catches a wrong cached basis with the Forge manifest check and retries a full ship',async()=>{
      const f=await setup(),t=presyncTransport(f,{tamper:true});
      expect((await remote.presync({cwd:repo,exec:t.transport,sshOptions:[]})).status).toBe('synced');
      const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]});
      // Never a pass on the wrong bytes: the delta run is refused, the full ship runs clean.
      expect(result).toMatchObject({mode:'remote',code:0});
      const ships=runRsync(t.calls);
      expect(ships).toHaveLength(2);
      expect(ships[1].args.some(a=>a.startsWith('--copy-dest='))).toBe(false);
      expect(result.timings.filter(s=>s.stage==='rsync').every(s=>s.shipMode==='delta-then-full')).toBe(true);
    },30_000);
    it.each(['other base','edited after presync','other host','corrupt state','no state'])('offers no basis for a stale or mismatched presync: %s',async fault=>{
      const f=await setup(),t=presyncTransport(f);
      expect((await remote.presync({cwd:repo,exec:t.transport,sshOptions:[]})).status).toBe('synced');
      const path=join(gitDir(),'forge-presync.json'),state=JSON.parse(await fs.readFile(path,'utf8'));
      if(fault==='other base')state.baseManifestDigest='0'.repeat(64);
      if(fault==='other host')state.host='elsewhere';
      await fs.writeFile(path,fault==='corrupt state'?'{':JSON.stringify(state));
      if(fault==='no state')await fs.rm(path);
      if(fault==='edited after presync')await fs.writeFile(join(repo,'a.test.mjs'),'edited again');
      const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]});
      expect(result).toMatchObject({mode:'remote',code:0});
      const [shipped]=runRsync(t.calls);
      expect(shipped.args.some(a=>a.startsWith('--copy-dest=')||a==='--checksum')).toBe(false);
      expect(result.timings.find(s=>s.stage==='rsync').presyncClaimed).toEqual({count:0,bytes:0});
    },30_000);
    it.each(['rsync fails','cache dir refused','ssh throws'])('records a presync failure and leaves the run unchanged: %s',async fault=>{
      const f=await setup(),t=presyncTransport(f,{presyncCopyCode:fault==='rsync fails'?23:0,mkdirCode:fault==='cache dir refused'?1:0});
      const transport=fault==='ssh throws'?vi.fn(async call=>{if(call.file==='ssh')throw new Error('ssh down');return t.transport(call);}):t.transport;
      const round=await remote.presync({cwd:repo,exec:transport,sshOptions:[]});
      expect(round.status).toBe('failed');
      const state=await remote.readPresyncState(gitDir());
      expect(state.error).toEqual(expect.any(String));
      expect(state.files).toBeUndefined();
      await expect(fs.stat(join(gitDir(),'forge-presync.lock'))).rejects.toMatchObject({code:'ENOENT'});
      const result=await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]});
      expect(result).toMatchObject({mode:'remote',code:0});
      expect(runRsync(t.calls)[0].args.some(a=>a.startsWith('--copy-dest='))).toBe(false);
    },30_000);
    it('holds one round per lane and takes over only a dead holder lock',async()=>{
      const f=await setup(),t=presyncTransport(f),lock=join(gitDir(),'forge-presync.lock');
      await fs.writeFile(lock,`${process.pid}\n`);
      expect(await remote.presync({cwd:repo,exec:t.transport,sshOptions:[]})).toEqual({status:'busy'});
      expect(t.calls.some(c=>c.file!=='git')).toBe(false);
      const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))']).stdout.toString();
      await fs.writeFile(lock,`${dead}\n`);
      expect((await remote.presync({cwd:repo,exec:t.transport,sshOptions:[]})).status).toBe('synced');
    },30_000);
    it('reuses a cached base manifest only when it hashes to the freshly advertised digest',async()=>{
      const f=await setup(),t=presyncTransport(f);
      const fetches=()=>t.calls.filter(c=>c.file==='ssh'&&c.args.at(-1).endsWith(' base-manifest')).length;
      expect((await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]})).mode).toBe('remote');
      expect(fetches()).toBe(1);
      expect(await remote.readCachedBaseManifest(gitDir(),'forge',f.base.manifestDigest)).toEqual(f.base.manifest);
      expect((await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]})).mode).toBe('remote');
      expect(fetches()).toBe(1);
      // A valid cache for another host is never used.
      expect(await remote.readCachedBaseManifest(gitDir(),'elsewhere',f.base.manifestDigest)).toBeUndefined();
      // Tampered bytes under the right digest label are refetched.
      const path=join(gitDir(),'forge-presync-base.json'),record=JSON.parse(await fs.readFile(path,'utf8'));
      record.wire.hashes[0]='0'.repeat(64);await fs.writeFile(path,JSON.stringify(record));
      expect(await remote.readCachedBaseManifest(gitDir(),'forge',f.base.manifestDigest)).toBeUndefined();
      expect((await remote.runRemote({argv:f.request.argv,cwd:repo,exec:t.transport,log:vi.fn(),sshOptions:[]})).mode).toBe('remote');
      expect(fetches()).toBe(2);
    },30_000);
    it('starts the next round detached with only PATH, HOME and SSH_AUTH_SOCK',()=>{
      const spawnFn=vi.fn(()=>({on(){},unref(){}}));
      remote.spawnPresync({cwd:repo,host:'forge',env:{PATH:'/bin',HOME:'/h',SSH_AUTH_SOCK:'/s',GITHUB_TOKEN:'ghs_secret',ANTHROPIC_API_KEY:'sk-secret'},spawnFn});
      const [file,args,options]=spawnFn.mock.calls[0];
      expect(file).toBe(process.execPath);
      expect(args.slice(1)).toEqual(['presync','--host=forge']);
      expect(options).toMatchObject({cwd:repo,detached:true,stdio:'ignore'});
      expect(options.env).toEqual({PATH:'/bin',HOME:'/h',SSH_AUTH_SOCK:'/s'});
    });
  });
});

// The warm tick's process boundary is injected: no network or registry access.
describe('warm-base tick',()=>{
  it('imports safely without changing the worker umask',async()=>{
    const mask=vi.spyOn(process,'umask').mockImplementation(()=>{throw Object.assign(new Error('unsupported in worker'),{code:'ERR_WORKER_UNSUPPORTED_OPERATION'});});
    try {
      await expect(import('../forge-warm-base.mjs')).resolves.toHaveProperty('warmTick');
      expect(mask).not.toHaveBeenCalled();
    } finally {mask.mockRestore();}
  });
  it.each(['supported','unsupported','missing'])('sets the Forge CLI umask when %s without breaking unsupported runtimes',async kind=>{
    const path=new URL('../forge-warm-base.mjs',import.meta.url).pathname;
    const script=`
      process.argv=[process.execPath,${JSON.stringify(path)},'unexpected'];
      process.umask=${kind==='missing'?'undefined':`mask=>{process.stdout.write('mask='+mask);${kind==='unsupported'?"throw new Error('unsupported');":''}}`};
      await import(${JSON.stringify(path)});
    `;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
    expect(child.status).toBe(1);
    expect(child.stdout).toBe(kind==='missing'?'':'mask=18');
    expect(child.stderr).toBe('forge-warm-base: No arguments accepted\n');
  });
  async function tickFixture() {
    const warm=await import('../forge-warm-base.mjs');const base=await baseFixture();let now=1000;
    const target=join(root,'bases');await fs.mkdir(target);
    const gitExec=vi.fn(async call=>{
      expect(Object.keys(call.env).some(k=>/token|secret|credential|auth/i.test(k))).toBe(false);
      expect(call.env.GIT_TERMINAL_PROMPT).toBe('0');
      if(call.args.includes('fetch')){expect(call.args).toContain('https://github.com/chalbert/web-everything.git');expect(call.args).toContain('credential.helper=');return {code:0,stdout:Buffer.alloc(0)};}
      if(call.args.includes('init')){await fs.mkdir(join(target,'repo.git'));return {code:0,stdout:Buffer.alloc(0)};}
      const args=call.args.slice(call.args.indexOf('--git-dir')+2);
      return exec({...call,args:['-C',repo,...args]});
    });
    const install=vi.fn(async()=>({code:0}));
    return {warm,base,target,gitExec,install,options:{root:target,exec:gitExec,install,clock:()=>now++,fs,runs:join(root,'slots'),receipts:join(root,'receipts')}};
  }
  it('publishes only ready verified trees, logs latency and does not pass tokens to anonymous git',async()=>{
    const f=await tickFixture();await f.warm.warmTick(f.options);
    const ready=JSON.parse(await fs.readFile(join(f.target,f.base.sha,'READY'),'utf8'));
    expect(ready).toMatchObject({sha:f.base.sha,manifestDigest:f.base.manifestDigest,lockDigest:hash('lock'),readyAtMs:expect.any(Number),fetchedAtMs:expect.any(Number)});
    const log=JSON.parse((await fs.readFile(join(f.target,'latency.log'),'utf8')).trim());
    expect(log).toMatchObject({sha:f.base.sha,mergeCommitDate:expect.any(String),fetchedAt:expect.any(String),readyAt:expect.any(String),latencyMs:expect.any(Number)});
    expect(f.install).toHaveBeenCalledOnce();await f.warm.warmTick(f.options);expect(f.install).toHaveBeenCalledOnce();
  });
  it('prewarms idle slots on publication and reuse, skips busy slots and preserves pinned older trees',async()=>{
    const f=await tickFixture();
    await fs.mkdir(f.options.runs,{mode:0o700});await fs.mkdir(f.options.receipts,{mode:0o700});
    for(const n of [1,2]){await fs.mkdir(join(f.options.runs,'slot-'+n),{mode:0o710});await fs.chmod(join(f.options.runs,'slot-'+n),0o710);}
    await fs.mkdir(join(f.options.receipts,'worker-active-2'));
    await f.warm.warmTick(f.options);
    const pool=join(f.target,'prewarm'),tree=join(pool,f.base.sha,'1');
    expect(await fs.readFile(join(tree,'mode.txt'),'utf8')).toBe('mode');
    expect((await fs.lstat(tree)).mode&0o777).toBe(0o700);
    await expect(fs.lstat(join(pool,f.base.sha,'2'))).rejects.toMatchObject({code:'ENOENT'});
    await fs.rm(tree,{recursive:true});await f.warm.warmTick(f.options);
    expect(await fs.readFile(join(tree,'mode.txt'),'utf8')).toBe('mode');expect(f.install).toHaveBeenCalledOnce();
    await fs.writeFile(join(f.target,'active','run'),f.base.sha);
    await fs.writeFile(join(repo,'new.txt'),'new');git(['add','.']);commit();git(['update-ref','refs/remotes/origin/main','HEAD']);
    await f.warm.warmTick(f.options);
    expect(await fs.readFile(join(tree,'mode.txt'),'utf8')).toBe('mode');
    await fs.rm(join(f.target,'active','run'));await f.warm.warmTick(f.options);
    await expect(fs.lstat(tree)).rejects.toMatchObject({code:'ENOENT'});
    expect(await fs.readdir(pool)).toEqual([git(['rev-parse','HEAD']).toString().trim()]);
  });
  async function slotFixture(count=2) {
    const f=await tickFixture();
    await fs.mkdir(f.options.runs,{mode:0o700});await fs.mkdir(f.options.receipts,{mode:0o700});
    for(let n=1;n<=count;n++)await fs.mkdir(join(f.options.runs,'slot-'+n),{mode:0o700});
    return f;
  }
  async function interceptPrewarmCopy(beforeMode) {
    const bases=await import('../forge-exec-bases.mjs'),copy=bases.copyLeaves;
    // The descriptor-pinned copier runs in Python, outside injected fs.writeFile.
    // Keep real copies and pause/fault with a partial tree before the mode leaf.
    return vi.spyOn(bases,'copyLeaves').mockImplementation(async(source,destination,entries)=>{
      expect(destination).toContain('/.prewarm-');
      const index=entries.findIndex(entry=>entry.path.equals(Buffer.from('mode.txt')));
      expect(index).toBeGreaterThan(0);
      await copy(source,destination,entries.slice(0,index));
      await beforeMode();
      await copy(source,destination,entries.slice(index));
    });
  }
  it.each([false,true])('retains untouched valid prewarm tree and leaf inodes across ticks (newest pinned: %s)',async pinned=>{
    const f=await slotFixture(1);await f.warm.warmTick(f.options);
    const tree=join(f.target,'prewarm',f.base.sha,'1'),leaf=join(tree,'mode.txt');
    const before=await Promise.all([fs.lstat(tree),fs.lstat(leaf)]);
    if(pinned)await fs.writeFile(join(f.target,'active','run'),f.base.sha);
    const write=vi.fn(fs.writeFile),read=vi.fn(fs.readFile);
    await f.warm.warmTick({...f.options,fs:{...fs,writeFile:write,readFile:read}});
    expect((await fs.lstat(tree)).ino).toBe(before[0].ino);expect((await fs.lstat(leaf)).ino).toBe(before[1].ino);
    expect(write.mock.calls.some(([path])=>String(path).endsWith('/mode.txt'))).toBe(false);
    expect(read.mock.calls.some(([path])=>String(path).includes('/tree/'))).toBe(false);
  });
  it('slow prewarm copy does not starve a concurrent baseGuard waiter or expose a partial tree',async()=>{
    const f=await slotFixture(1);let entered,release;
    const copying=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
    await interceptPrewarmCopy(async()=>{entered();await held;});
    const tick=f.warm.warmTick(f.options);
    try {
      await copying;let now=0;
      await expect(baseGuard(f.target,async()=>{
        expect(await fs.readdir(join(f.target,'active'))).not.toEqual([]);
        const dest=join(root,'partial-claim'),verify=vi.fn();
        expect(await claimPrewarm(f.target,f.base.sha,'1',dest,f.base.manifest,f.base.manifestDigest,verify)).toBe(false);
        expect(verify).not.toHaveBeenCalled();
        return 42;
      },fs,{waitMs:50,retryMs:25,clock:()=>now,sleep:async ms=>{now+=ms;}})).resolves.toBe(42);
    }finally{release();await tick;}
    expect(await fs.readFile(join(f.target,'prewarm',f.base.sha,'1','mode.txt'),'utf8')).toBe('mode');
    expect(await fs.readdir(join(f.target,'active'))).toEqual([]);
    expect((await fs.readdir(f.target)).filter(name=>name.startsWith('.prewarm-'))).toEqual([]);
  });
  it('keeps publication successful and attempts other slots after one copy fails',async()=>{
    const f=await slotFixture(3),log=vi.fn();let failed=false;
    await interceptPrewarmCopy(async()=>{
      if(!failed){failed=true;throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}
    });
    await expect(f.warm.warmTick({...f.options,log})).resolves.toMatchObject({sha:f.base.sha});
    expect(failed).toBe(true);expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    const parent=join(f.target,'prewarm',f.base.sha),trees=(await fs.readdir(parent)).filter(name=>/^[1-9]\d*$/.test(name));
    expect(trees).toHaveLength(2);
    for(const name of trees)expect(await fs.readFile(join(parent,name,'mode.txt'),'utf8')).toBe('mode');
    expect(await fs.readdir(join(f.target,'active'))).toEqual([]);
    expect((await fs.readdir(f.target)).filter(name=>name.startsWith('.prewarm-'))).toEqual([]);
  });
  it.each(['busy','pinned'])('rechecks a slot that becomes %s while its replacement is copied',async fault=>{
    const f=await slotFixture(1);await f.warm.warmTick(f.options);
    const tree=join(f.target,'prewarm',f.base.sha,'1'),inode=(await fs.lstat(tree)).ino;
    await fs.writeFile(tree+'.json','{}');
    let raced=false;
    await interceptPrewarmCopy(async()=>{
      if(!raced) {
        raced=true;
        await baseGuard(f.target,async()=>{
          if(fault==='busy')await fs.mkdir(join(f.options.receipts,'worker-active-1'));
          else await createBasePin(f.target,'runner',f.base.sha);
        });
      }
    });
    await f.warm.warmTick(f.options);
    expect(raced).toBe(true);expect((await fs.lstat(tree)).ino).toBe(inode);
    expect(await fs.readFile(tree+'.json','utf8')).toBe('{}');
    expect(await fs.readdir(join(f.target,'active'))).toEqual(fault==='pinned'?['runner']:[]);
  });
  it('preserves an existing pinned newest entry even when its marker needs repair',async()=>{
    const f=await slotFixture(1);await f.warm.warmTick(f.options);
    const tree=join(f.target,'prewarm',f.base.sha,'1'),inode=(await fs.lstat(tree)).ino;
    await fs.writeFile(tree+'.json','{}');await createBasePin(f.target,'runner',f.base.sha);
    await f.warm.warmTick(f.options);
    expect((await fs.lstat(tree)).ino).toBe(inode);expect(await fs.readFile(tree+'.json','utf8')).toBe('{}');
  });
  it('rolls back a failed marker publication and continues warming other slots',async()=>{
    const f=await slotFixture(2),log=vi.fn(),parent=join(f.target,'prewarm',f.base.sha);let failed=false;
    const io={...fs,rename:async(from,to)=>{
      if(!failed&&to===join(parent,'1.json')){failed=true;throw new Error('marker rename failed');}
      return fs.rename(from,to);
    }};
    await expect(f.warm.warmTick({...f.options,fs:io,log})).resolves.toMatchObject({sha:f.base.sha});
    expect(failed).toBe(true);expect(log).toHaveBeenCalledWith(expect.stringContaining('marker rename failed'));
    await expect(fs.lstat(join(parent,'1'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await fs.readFile(join(parent,'2','mode.txt'),'utf8')).toBe('mode');
    expect(await fs.readdir(join(f.target,'active'))).toEqual([]);
  });
  it('reclaims abandoned build trees and orphan source pins without deleting under the guard',async()=>{
    const f=await slotFixture(1);await f.warm.warmTick(f.options);
    const abandoned=join(f.target,'.prewarm-ABC123'),active=join(f.target,'active');
    await fs.mkdir(abandoned,{mode:0o700});await fs.writeFile(join(abandoned,'partial'),'partial');
    await fs.mkdir(join(f.target,'.prewarm-NOP456'),{mode:0o700});
    await fs.writeFile(join(active,'.prewarm-ABC123'),f.base.sha);
    await fs.writeFile(join(active,'.prewarm-XYZ789'),f.base.sha);
    await createBasePin(f.target,'runner',f.base.sha);
    const io={...fs,rm:async(path,...args)=>{
      if(args[0]?.recursive&&String(path).includes('.prewarm-')) {
        let now=0;
        expect(await baseGuard(f.target,()=>42,fs,{clock:()=>now,sleep:async ms=>{now+=ms;},waitMs:50})).toBe(42);
      }
      return fs.rm(path,...args);
    }};
    await f.warm.warmTick({...f.options,fs:io});
    expect(await fs.readdir(active)).toEqual(['runner']);
    expect((await fs.readdir(f.target)).filter(name=>name.startsWith('.prewarm-'))).toEqual([]);
  });
  it.each(['unknown pool entry','slot cap','invalid active pin'])('treats prewarm %s as non-fatal while refusing unsafe work',async fault=>{
    const f=await slotFixture(1);await f.warm.warmTick(f.options);
    const tree=join(f.target,'prewarm',f.base.sha,'1'),inode=(await fs.lstat(tree)).ino,log=vi.fn();
    if(fault==='unknown pool entry')await fs.writeFile(join(f.target,'prewarm','unexpected'),'keep');
    const io={...fs,readdir:async(path,...args)=>String(path)===f.options.runs&&fault==='slot cap'?Array.from({length:129},(_,i)=>'slot-'+(i+1)):fs.readdir(path,...args)};
    const gitExec=async call=>{
      const result=await f.gitExec(call);
      if(fault==='invalid active pin'&&call.args.includes('fetch'))await fs.writeFile(join(f.target,'active','bad'),'invalid');
      return result;
    };
    await expect(f.warm.warmTick({...f.options,fs:io,exec:gitExec,log})).resolves.toMatchObject({reused:true});
    expect(log).toHaveBeenCalledWith(expect.stringContaining(fault==='unknown pool entry'?'Unknown prewarm entry':fault==='slot cap'?'slot bound':'Invalid active pin'));
    expect((await fs.lstat(tree)).ino).toBe(inode);
    expect(f.install).toHaveBeenCalledOnce();
  });
  it('warm tick tolerates a transient shared guard EEXIST',async()=>{
    const f=await tickFixture();let collisions=0;
    const mkdir=async(path,options)=>{if(path===join(f.target,'.guard')&&collisions++<2)throw Object.assign(new Error('busy'),{code:'EEXIST'});return fs.mkdir(path,options);};
    await f.warm.warmTick({...f.options,fs:{...fs,mkdir}});
    expect(f.install).toHaveBeenCalledOnce();expect(collisions).toBeGreaterThanOrEqual(3);
  });
  it.each(['missing tree','missing leaf','extra leaf','same-size corruption','bad marker','oversized marker','overdeep tree','symlink leaf','malformed READY'])('removes and rebuilds a previously advertised %s base',async fault=>{
    const f=await tickFixture();await f.warm.warmTick(f.options);
    const dir=join(f.target,f.base.sha);
    if(fault==='missing tree')await fs.rm(join(dir,'tree'),{recursive:true});
    if(fault==='missing leaf')await fs.rm(join(dir,'tree/mode.txt'));
    if(fault==='extra leaf')await fs.writeFile(join(dir,'tree/extra.txt'),'extra');
    if(fault==='same-size corruption')await fs.writeFile(join(dir,'tree/mode.txt'),'evil');
    if(fault==='bad marker')await fs.writeFile(join(dir,'tree-digest.json'),'{}');
    if(fault==='oversized marker')await fs.writeFile(join(dir,'tree-digest.json'),'x'.repeat(4*1024*1024+1));
    if(fault==='overdeep tree')await fs.mkdir(join(dir,'tree',...Array(130).fill('deep')),{recursive:true});
    if(fault==='symlink leaf'){await fs.rm(join(dir,'tree/mode.txt'));await fs.symlink(join(repo,'mode.txt'),join(dir,'tree/mode.txt'));}
    if(fault==='malformed READY')await fs.writeFile(join(dir,'READY'),'{}');
    await f.warm.warmTick(f.options);
    expect(f.install).toHaveBeenCalledTimes(2);
    const {verifyManifest}=await import('../forge-exec-run.mjs');
    await verifyManifest(join(dir,'tree'),f.base.manifest,f.base.manifestDigest);
  });
  it('rehashes legacy bases once when the marker is missing, then checks metadata only',async()=>{
    const f=await tickFixture();await f.warm.warmTick(f.options);
    const dir=join(f.target,f.base.sha),marker=join(dir,'tree-digest.json');
    await fs.rm(marker,{force:true});
    const read=vi.fn(path=>fs.readFile(path));
    await f.warm.warmTick({...f.options,fs:{...fs,readFile:read}});
    expect(read.mock.calls.some(([path])=>Buffer.from(path).includes(Buffer.from('/tree/')))).toBe(true);
    expect(JSON.parse(await fs.readFile(marker,'utf8'))).toMatchObject({manifestDigest:f.base.manifestDigest,fileCount:f.base.manifest.hashes.length,treeDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    read.mockClear();await f.warm.warmTick({...f.options,fs:{...fs,readFile:read}});
    expect(read.mock.calls.some(([path])=>Buffer.from(path).includes(Buffer.from('/tree/')))).toBe(false);
    expect(f.install).toHaveBeenCalledOnce();
  });
  it('rejects corrupt legacy bytes when the tree marker is missing',async()=>{
    const f=await tickFixture();await f.warm.warmTick(f.options);
    const dir=join(f.target,f.base.sha);await fs.rm(join(dir,'tree-digest.json'),{force:true});await fs.writeFile(join(dir,'tree/mode.txt'),'evil');
    await f.warm.warmTick(f.options);expect(f.install).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(join(dir,'tree/mode.txt'),'utf8')).toBe('mode');
  });
  it('repairs a retained older base even when current main is healthy',async()=>{
    const f=await tickFixture();await f.warm.warmTick(f.options);
    await fs.writeFile(join(repo,'new.txt'),'new main');git(['add','.']);commit();git(['update-ref','refs/remotes/origin/main','HEAD']);
    await f.warm.warmTick(f.options);expect(f.install).toHaveBeenCalledTimes(2);
    await fs.writeFile(join(f.target,f.base.sha,'tree/mode.txt'),'evil');
    expect(await f.warm.warmTick(f.options)).toMatchObject({reused:true});
    expect(f.install).toHaveBeenCalledTimes(3);
    expect(await fs.readFile(join(f.target,f.base.sha,'tree/mode.txt'),'utf8')).toBe('mode');
  });
  it('failed install leaves no READY or stale temporary tree',async()=>{
    const f=await tickFixture();f.install.mockRejectedValue(new Error('npm failed'));
    await expect(f.warm.warmTick(f.options)).rejects.toThrow('npm failed');
    expect(await fs.readdir(f.target)).not.toContain(f.base.sha);
    expect((await fs.readdir(f.target)).filter(n=>n.endsWith('.tmp'))).toEqual([]);
  });
  it('retains newest twelve plus active bases, prunes stale tmp dirs and never follows symlinks',async()=>{
    const f=await tickFixture();
    await f.warm.warmTick(f.options);
    for(let i=0;i<14;i++){const sha=i.toString(16).repeat(40);await fs.cp(join(f.target,f.base.sha),join(f.target,sha),{recursive:true});await fs.rm(join(f.target,sha,'tree-digest.json'));await fs.writeFile(join(f.target,sha,'READY'),JSON.stringify({sha,manifestDigest:f.base.manifestDigest,lockDigest:hash('lock'),readyAtMs:i,fetchedAtMs:i}));}
    await fs.mkdir(join(f.target,'failed.tmp'));await fs.mkdir(join(f.target,'active'),{recursive:true});await fs.writeFile(join(f.target,'active','run-one'),'0'.repeat(40));
    await f.warm.warmTick(f.options);
    const dirs=await fs.readdir(f.target);expect(dirs).toContain('0'.repeat(40));expect(dirs).not.toContain('1'.repeat(40));expect(dirs).not.toContain('2'.repeat(40));expect(dirs).not.toContain('failed.tmp');
    const advertised=await createRunner({testRoot:root}).bases();
    expect(advertised.bases).toHaveLength(12);expect(advertised.bases.some(b=>b.sha==='0'.repeat(40))).toBe(false);
  });
});

describe('bounded shared base guard contention',()=>{
  it.each([
    ['pending','EACCES'],['pending','EPERM'],['guard','EACCES'],['guard','EPERM'],
  ])('does not retry a %s mkdir %s failure or execute the guarded action',async(stage,code)=>{
    const target=join(root,'guard-test'),guard=join(target,'.guard');
    await fs.mkdir(target,{mode:0o700});
    const sleep=vi.fn(),action=vi.fn(),denied=vi.fn();
    const io={...fs,mkdir:async(path,options)=>{
      if(stage==='pending'?path.startsWith(join(target,'.guard-pending-')):path===guard) {
        denied();throw Object.assign(new Error('denied'),{code});
      }
      return fs.mkdir(path,options);
    }};
    await expect(baseGuard(target,action,io,{sleep})).rejects.toMatchObject({code});
    expect(denied).toHaveBeenCalledOnce();expect(sleep).not.toHaveBeenCalled();expect(action).not.toHaveBeenCalled();
    expect(await fs.readdir(target)).toEqual([]);
  });
  it.each([0,3,6])('retries EEXIST within the deadline with at most five waits (failures=%s)',async failures=>{
    const target=join(root,'guard-test'),guard=join(target,'.guard'),owner='owner-'+'a'.repeat(32);
    await fs.mkdir(target,{mode:0o700});
    const holder=JSON.stringify({pid:process.pid,timestamp:0});
    if(failures){await fs.mkdir(guard,{mode:0o700});await fs.writeFile(join(guard,owner),holder);}
    let now=0,tries=0;
    const sleep=vi.fn(async ms=>{
      now+=ms;
      if(sleep.mock.calls.length===failures){await fs.unlink(join(guard,owner));await fs.rmdir(guard);}
    }),action=vi.fn(async()=>42);
    const io={...fs,mkdir:async(path,options)=>{
      if(path===guard)tries++;
      return fs.mkdir(path,options);
    },unlink:vi.fn(fs.unlink),rmdir:vi.fn(fs.rmdir),rm:vi.fn(fs.rm)};
    const result=baseGuard(target,action,io,{clock:()=>now,sleep,waitMs:125,retryMs:25});
    if(failures===6){
      await expect(result).rejects.toThrow('Base guard wait exceeded; use local fallback and inspect the guard owner');
      expect(action).not.toHaveBeenCalled();expect(io.unlink).not.toHaveBeenCalled();expect(io.rmdir).not.toHaveBeenCalled();
      expect(await fs.readFile(join(guard,owner),'utf8')).toBe(holder);
      expect(await fs.readdir(target)).toEqual(['.guard']);
    } else {
      expect(await result).toBe(42);expect(action).toHaveBeenCalledOnce();expect(io.unlink).toHaveBeenCalledOnce();expect(io.rmdir).toHaveBeenCalledOnce();
      expect(await fs.readdir(target)).toEqual([]);
    }
    expect(tries).toBe(Math.min(failures+1,6));
    expect(sleep.mock.calls).toEqual(Array.from({length:Math.min(failures,5)},()=>[25]));
    expect(now).toBe(Math.min(failures,5)*25);
    expect(io.rm).toHaveBeenCalledOnce();
    expect(io.rm).toHaveBeenCalledWith(expect.stringMatching(/\/\.guard-pending-[a-f0-9]{32}$/),{recursive:true,force:true});
  });
});
