// @vitest-environment node
import {afterEach,beforeEach,expect,it} from 'vitest';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import * as runnerAPI from '../forge-exec-run.mjs';
import {exerciseGitMetadataAttack} from './fixtures/forge-git-metadata-attack.mjs';

let root;
beforeEach(async()=>{
  root=await fs.mkdtemp(join(process.env.TMPDIR,'forge-ownership-'));
  await fs.mkdir(join(root,'runs','slot-1'),{recursive:true,mode:0o710});
});
afterEach(async()=>fs.rm(root,{recursive:true,force:true}));
const execute=call=>{
  const result=spawnSync('python3',call.args.slice(call.args.indexOf('-I')),{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  return {code:result.status,stdout:result.stdout,stderr:result.stderr};
};

it('keeps privileged Git in protected metadata when the worker substitutes a real fsmonitor repository',async()=>{
  await exerciseGitMetadataAttack(root);
},30000);

it.skipIf(process.platform!=='linux')('a surviving actual worker UID cannot substitute protected Git metadata or execute an fsmonitor payload as root',()=>{
  const driver=`import {exerciseGitMetadataAttack} from ${JSON.stringify(new URL('./fixtures/forge-git-metadata-attack.mjs',import.meta.url).href)};
await exerciseGitMetadataAttack(process.env.TMPDIR,{workerUid:65533});
console.log('distinct-uid-git-metadata-safe');`;
  // Absolute worker paths must not cross Vitest's private 0700 run root. Use
  // Linux's shared temp parent without changing any shared ancestor's mode.
  // Python retains privilege and removes root/worker-owned files on failure too.
  const python=`import os,subprocess,sys,tempfile
with tempfile.TemporaryDirectory(prefix='forge-ownership-',dir='/tmp') as fixture:
 result=subprocess.run([sys.argv[1],'--input-type=module','-e',sys.argv[2]],env={'PATH':os.environ['PATH'],'TMPDIR':fixture},timeout=25)
 sys.exit(result.returncode)
`;
  const result=spawnSync('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-c',python,process.execPath,driver],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('distinct-uid-git-metadata-safe');
},40000);

it.each(['work','container'])('prepare refuses a replaced %s endpoint without touching the symlink target',async target=>{
  const victim=join(root,'unrelated');await fs.mkdir(victim,{mode:0o700});
  await fs.writeFile(join(victim,'keep'),'unchanged');
  const before=await fs.stat(victim);let calls=0;
  const worker={uid:process.getuid()+1,gid:process.getgid()+1};
  const runner=runnerAPI.createRunner({testRoot:root,
    testWorkerIdentity:()=>({...worker,groups:[worker.gid]}),
    // Model the private slot group on unprivileged hosts; retain real modes,
    // inodes and the descriptor-based handoff that must reject the symlink.
    testSlotStat:async path=>Object.assign(await fs.lstat(path),{gid:worker.gid}),
    testOwnershipExec:async call=>{
      calls++;
      const cfg=JSON.parse(call.args.at(-1)),path=join(cfg.root,...cfg.parts.slice(0,target==='container'?-1:undefined));
      await fs.rename(path,path+'.saved');await fs.symlink(victim,path);
      return execute(call);
    }});
  await expect(runner.prepare({nonce:'a'.repeat(32)})).rejects.toThrow('ownership');
  expect(calls).toBe(1);
  expect(await fs.stat(victim)).toMatchObject({uid:before.uid,gid:before.gid,ino:before.ino,mode:before.mode});
  expect(await fs.readFile(join(victim,'keep'),'utf8')).toBe('unchanged');
});

it.each(['symlink','hardlink','deep tree'])('descriptor handoff rejects an unsafe %s with a local-fallback diagnostic',async kind=>{
  expect(runnerAPI.ownershipSource).toBeTypeOf('string');
  const work=join(root,'runs','slot-1','r-test','work'),victim=join(root,'unrelated');
  await fs.mkdir(work,{recursive:true});await fs.writeFile(victim,'keep');
  if(kind==='symlink')await fs.symlink(victim,join(work,'unsafe'));
  if(kind==='hardlink')await fs.link(victim,join(work,'unsafe'));
  if(kind==='deep tree')await fs.mkdir(join(work,...Array(130).fill('d')),{recursive:true});
  const result=execute({args:['-I','-c',runnerAPI.ownershipSource,JSON.stringify({root:join(root,'runs'),parts:['slot-1','r-test','work'],operator:{uid:process.getuid(),gid:process.getgid()},worker:{uid:process.getuid(),gid:process.getgid()},recursive:true})]});
  expect(result.code).not.toBe(0);expect(result.stderr).toContain('use local fallback');
  expect(await fs.readFile(victim,'utf8')).toBe('keep');
});

it.each(['allowed work','flag absent','worker git','symlink git','worker slot','worker run','non-work parent','work at wrong depth'])(
  'workerParent handoff permits only the immediate work ancestor: %s',async fault=>{
    const parts=fault==='work at wrong depth'?['slot-1','work','run','.git']:
      ['slot-1','run',fault==='non-work parent'?'other':'work','.git'];
    const target=join(root,'runs',...parts),leaf=join(target,'config');
    await fs.mkdir(target,{recursive:true});await fs.writeFile(leaf,'trusted metadata');
    const worker={uid:process.getuid()+10000,gid:process.getgid()+10000};
    const workerPaths=[fault==='work at wrong depth'?join(root,'runs','slot-1','work'):
      join(root,'runs',...parts.slice(0,-1))];
    if(fault==='worker git')workerPaths.push(target);
    if(fault==='worker slot')workerPaths.push(join(root,'runs','slot-1'));
    if(fault==='worker run')workerPaths.push(join(root,'runs','slot-1','run'));
    if(fault==='symlink git'){
      await fs.rename(target,target+'.saved');await fs.symlink(target+'.saved',target);
    }
    // Model distinct ownership on unprivileged hosts while exercising the real
    // Python traversal, descriptors, inode checks and symlink refusal.
    const preamble=`import os, json
worker_paths = json.loads(${JSON.stringify(JSON.stringify(workerPaths))})
worker_inodes = {(os.stat(p).st_dev, os.stat(p).st_ino) for p in worker_paths}
real_fstat = os.fstat
transferred = []
def modeled_fstat(fd):
    st = real_fstat(fd)
    if (st.st_dev, st.st_ino) in worker_inodes:
        fields = list(st)
        fields[4] = ${worker.uid}
        return os.stat_result(fields)
    return st
def recorded_chown(fd, uid, gid):
    assert (uid, gid) == (${worker.uid}, ${worker.gid})
    transferred.append(real_fstat(fd).st_ino)
os.fstat = modeled_fstat
os.fchown = recorded_chown
`;
    const expected=[(await fs.stat(leaf)).ino,(await fs.stat(target)).ino];
    const source=preamble+'try:\n'+runnerAPI.ownershipSource.split('\n').map(line=>'    '+line).join('\n')+
      '\nfinally:\n    print(json.dumps(transferred))\n';
    const cfg={root:join(root,'runs'),parts,operator:{uid:process.getuid(),gid:process.getgid()},worker,
      recursive:true,workerParent:fault!=='flag absent'};
    const result=execute({args:['-I','-c',source,JSON.stringify(cfg)]});
    if(fault==='allowed work'){
      expect(result.code,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual(expected);
    }else{
      expect(result.code,result.stderr).not.toBe(0);expect(result.stderr).toContain('Unsafe ownership handoff');
      expect(JSON.parse(result.stdout)).toEqual([]);
    }
    expect(await fs.readFile(leaf,'utf8')).toBe('trusted metadata');
  });

it('hands over a regular nested tree using verified descriptors in child-before-parent order',async()=>{
  const work=join(root,'runs','slot-1','work');await fs.mkdir(join(work,'nested'),{recursive:true});
  await fs.writeFile(join(work,'nested','file'),'public');
  const preamble=`import os, stat
real_chown=os.fchown
order=[]
def recorded(fd, uid, gid):
    order.append(stat.S_ISDIR(os.fstat(fd).st_mode))
    real_chown(fd, uid, gid)
os.fchown=recorded
`;
  const result=execute({args:['-I','-c',preamble+runnerAPI.ownershipSource+'\nassert order == [False, True, True]\n',JSON.stringify({root:join(root,'runs'),parts:['slot-1','work'],operator:{uid:process.getuid(),gid:process.getgid()},worker:{uid:process.getuid(),gid:process.getgid()},recursive:true})]});
  expect(result.code,result.stderr).toBe(0);
  expect(await fs.readFile(join(work,'nested','file'),'utf8')).toBe('public');
});

it('pins the directory inode across an endpoint swap immediately before fchown',async()=>{
  expect(runnerAPI.ownershipSource).toBeTypeOf('string');
  const slot=join(root,'runs','slot-1'),work=join(slot,'work'),victim=join(root,'unrelated');
  await fs.mkdir(work);await fs.mkdir(victim);
  const preamble=`import os, json, sys
real_chown=os.fchown
def swapped(fd, uid, gid):
    os.rename(${JSON.stringify(work)}, ${JSON.stringify(work+'.saved')})
    os.symlink(${JSON.stringify(victim)}, ${JSON.stringify(work)})
    assert os.fstat(fd).st_ino == os.stat(${JSON.stringify(work+'.saved')}).st_ino
    assert os.fstat(fd).st_ino != os.stat(${JSON.stringify(victim)}).st_ino
    real_chown(fd, uid, gid)
os.fchown=swapped
`;
  const result=execute({args:['-I','-c',preamble+runnerAPI.ownershipSource,JSON.stringify({root:join(root,'runs'),parts:['slot-1','work'],operator:{uid:process.getuid(),gid:process.getgid()},worker:{uid:process.getuid(),gid:process.getgid()},recursive:false})]});
  expect(result.code,result.stderr).toBe(0);
  expect((await fs.lstat(work)).isSymbolicLink()).toBe(true);
});

// Required on Linux under the same passwordless-python sudo contract as the
// existing cross-identity runner tests. Real numeric UIDs; no accounts created.
it.skipIf(process.platform!=='linux')('a surviving actual worker UID cannot swap prepare work/container paths or take another slot ownership',async()=>{
  const driver=`
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRunner} from ${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)};
const root=${JSON.stringify(root)},uid=65533,gid=65533;
await fs.chmod(root,0o755);
await fs.chown(join(root,'runs'),0,0);
await fs.chown(join(root,'runs','slot-1'),0,gid);
await fs.mkdir(join(root,'runs','slot-2'),{mode:0o710});
await fs.chown(join(root,'runs','slot-2'),0,65534);
const victim=join(root,'runs','slot-2'),before=await fs.stat(victim);let attempted=0;
const runner=createRunner({testRoot:root,testWorkerIdentity:user=>{
  const worker=user.endsWith('-1')?{uid,gid}:{uid:65534,gid:65534};
  return {...worker,groups:[worker.gid]};
},
  testOwnershipExec:async call=>{
    const cfg=JSON.parse(call.args.at(-1)),run=cfg.parts[1];
    const actor=spawnSync('python3',['-I','-c',
      'import os,sys; os.setgroups([]); os.setgid('+gid+'); os.setuid('+uid+'); blocked=0\\n'+
      'for path in sys.argv[1:]:\\n'+
      ' try: os.rename(path,path+".swapped"); os.symlink('+JSON.stringify(victim)+',path)\\n'+
      ' except PermissionError: blocked+=1\\n'+
      'assert blocked==2, "worker replaced a privileged metadata path"',run,run+'/work'],
      {cwd:join(root,'runs','slot-1'),encoding:'utf8',timeout:10000});
    assert.equal(actor.status,0,actor.stderr);attempted++;
    const result=spawnSync('python3',call.args.slice(call.args.indexOf('-I')),{encoding:'utf8',timeout:10000});
    return {code:result.status,stderr:result.stderr};
  }});
const p=await runner.prepare({nonce:'a'.repeat(32),siblings:true});
assert.equal(attempted,2);
assert.equal((await fs.stat(join(root,'runs','slot-1',p.run,'work'))).uid,uid);
assert.equal((await fs.stat(join(root,'runs','slot-1',p.run,'frontierui'))).uid,uid);
const after=await fs.stat(victim);assert.equal(after.uid,before.uid);assert.equal(after.gid,before.gid);assert.equal(after.mode,before.mode);
console.log('distinct-uid-prepare-safe');
`;
  const python=`import os,sys; os.execve(sys.argv[1],[sys.argv[1],'--input-type=module','-e',sys.argv[2]],{'PATH':os.environ['PATH'],'TMPDIR':sys.argv[3]})`;
  const result=spawnSync('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-c',python,process.execPath,driver,process.env.TMPDIR],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  try{expect(result.status,result.stderr).toBe(0);expect(result.stdout).toContain('distinct-uid-prepare-safe');}
  finally{
    const clean=spawnSync('/usr/bin/sudo',['-n','/usr/bin/python3','-I','-c','import shutil,sys; shutil.rmtree(sys.argv[1])',root],{encoding:'utf8',timeout:10000});
    expect(clean.status,clean.stderr).toBe(0);
  }
},30000);
