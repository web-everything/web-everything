// @vitest-environment node
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {createRunner as productionRunner, digestArgv, digestInput, manifestWire, digestManifest, supervisorSource} from '../forge-exec-run.mjs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as bases from '../forge-exec-bases.mjs';
import {buildManifest} from '../remote-exec.mjs';
import {scanMaterializedGuards} from './fixtures/forge-git-guards.mjs';
import {cachedPublicGitExec} from './fixtures/forge-public-git.mjs';

// Simulate only filesystem ownership; retain real directory modes/inodes and
// run every production identity/ownership check on the supplied evidence.
const workerIdentity=user=>{
  const k=Number(user.split('-').at(-1)),uid=process.getuid()+1000+k,gid=process.getgid()+2000+k;
  return {uid,gid,groups:[gid]};
};
const slotStat=async path=>Object.assign(await fs.lstat(path),{uid:process.getuid(),gid:workerIdentity(path).gid});
const createRunner=options=>productionRunner({testSlotStat:slotStat,
  testWorkerIdentity:workerIdentity,...options});
let root, runner;
const nonce='a'.repeat(32), hash=value=>createHash('sha256').update(value).digest('hex');
beforeEach(async()=>{
  root=await fs.mkdtemp(join(process.env.TMPDIR,'forge-pool-'));
  for(const k of [1,2])await fs.mkdir(join(root,'runs',`slot-${k}`),{recursive:true,mode:0o710});
  runner=createRunner({testRoot:root,testPath:'/usr/bin:/bin'});
});
afterEach(async()=>fs.rm(root,{recursive:true,force:true}));
const work=p=>join(root,'runs',p.slot.replace('forge-exec-','slot-'),p.run,'work');
const lock=p=>join(root,'receipts','worker-active-'+p.slot.split('-').at(-1));
describe('per-user worker reservations',()=>{
  it('legacy fixtures without isolation injections reserve multiple slots as the operator',async()=>{
    runner=productionRunner({testRoot:root,testPath:'/usr/bin:/bin'});
    const a=await runner.prepare({nonce}),b=await runner.prepare({nonce});
    expect([a.slot,b.slot]).toEqual(['forge-exec-1','forge-exec-2']);
    for(const p of [a,b])expect(p.worker).toMatchObject({uid:process.getuid(),gid:process.getgid()});
    await runner.finish({...a,nonce});await runner.finish({...b,nonce});
  });
  it('an identity injection alone still requires real slot ownership to match',async()=>{
    runner=productionRunner({testRoot:root,testWorkerIdentity:workerIdentity});
    await expect(runner.prepare({nonce})).rejects.toThrow('Untrusted slot directory');
    expect(await fs.readdir(join(root,'receipts'))).toEqual([]);
  });
  it('a slot-stat injection alone enforces isolation against resolved system identities',async()=>{
    const identity=workerIdentity('forge-exec-1');
    // Supply system id output without requiring forge-exec accounts on the host.
    const lookup=vi.fn(async(file,args)=>{
      expect(file).toBe('/usr/bin/id');
      expect(args[1]).toBe('forge-exec-1');
      expect(['-u','-g','-G']).toContain(args[0]);
      return {code:0,stdout:String(args[0]==='-u'?identity.uid:identity.gid)+'\n',stderr:''};
    });
    const stat=vi.fn(async path=>Object.assign(await fs.lstat(path),{uid:process.getuid()+1,gid:identity.gid}));
    runner=productionRunner({testRoot:root,testSlotStat:stat,testIdExec:lookup});
    await expect(runner.prepare({nonce})).rejects.toThrow('Untrusted slot directory');
    expect(stat).toHaveBeenCalledOnce();
    expect(lookup.mock.calls).toEqual(['-u','-g','-G'].map(flag=>['/usr/bin/id',[flag,'forge-exec-1']]));
    expect(await fs.readdir(join(root,'receipts'))).toEqual([]);
  });
  it.each(['symlink','non-private mode'])('legacy fixtures still refuse a %s slot directory',async fault=>{
    const slot=join(root,'runs/slot-1');
    if(fault==='symlink'){
      await fs.rename(slot,slot+'.saved');await fs.symlink(slot+'.saved',slot);
    }else await fs.chmod(slot,0o777);
    runner=productionRunner({testRoot:root});
    await expect(runner.prepare({nonce})).rejects.toThrow('Untrusted slot directory');
    expect(await fs.readdir(join(root,'receipts'))).toEqual([]);
  });
  it('explicit isolation never accepts UID zero',async()=>{
    const identity=user=>({...workerIdentity(user),uid:0});
    runner=createRunner({testRoot:root,testWorkerIdentity:identity,testSlotStat:slotStat});
    await expect(runner.prepare({nonce})).rejects.toThrow(process.getuid()===0?'Worker must not share the operator identity':'Unknown worker identity');
    expect(await fs.readdir(join(root,'receipts'))).toEqual([]);
  });
  async function requestFor(p) {
    const dir=work(p);await fs.writeFile(join(dir,'package-lock.json'),'lock');
    const manifest=manifestWire({entries:[{path:Buffer.from('package-lock.json'),sha256:hash('lock'),executable:false}],excluded:[]});
    const argv=['npm','run','test:unit'];
    return {...p,nonce,argv,env:{},lock:hash('lock'),manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(dir),argvDigest:digestArgv(argv)};
  }
  async function pruneWithoutUidProcesses(before='',after='') {
    const setup=await fs.readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    const body=setup.match(/<<'PRUNE_PY'\n([\s\S]*?)\nPRUNE_PY/)[1];
    const proc=join(root,'proc');await fs.mkdir(proc,{recursive:true});
    const local=body.replaceAll('/srv/forge-exec',join(root,'runs')).replaceAll('/srv/forge-receipts',join(root,'receipts'))
      .replaceAll('/srv/forge-cache',join(root,'cache')).replaceAll('/proc',proc);
    return spawnSync('python3',['-I','-c',`import pwd, types, os\npwd.getpwnam=lambda _:types.SimpleNamespace(pw_uid=os.getuid())\n${before}\n${local}\n${after}`],
      {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  }
  it.each(['new','persisted'])('root pruning hands %s private writer inodes to the operator before slot acquisition',async mode=>{
    await runner.telemetry();
    const names=['worker-active','worker-active-1','worker-active-2'],inodes=[];
    if(mode==='persisted')for(const name of names){
      const path=join(root,'receipts','.'+name+'.writer');await fs.writeFile(path,'',{mode:0o600});
      inodes.push((await fs.stat(path)).ino);
    }
    // Model root guards and a distinct operator even when this test runs as
    // root. Real opens, modes, inodes and flock remain intact; missing fchown
    // fails the ownership proof on both privileged and unprivileged hosts.
    const before=String.raw`original_open, original_fstat, original_stat = os.open, os.fstat, os.stat
operator = (os.getuid() or 1000, os.getgid() or 1000)
owners = {}
def operator_stat(path, *args, **kwargs):
    st = original_stat(path, *args, **kwargs)
    values = list(st)
    if path == ${JSON.stringify(join(root,'receipts'))}: values[4:6] = operator
    return os.stat_result(values)
def root_open(path, *args, **kwargs):
    fd = original_open(path, *args, **kwargs)
    if str(path).endswith('.writer'): owners.setdefault(original_fstat(fd).st_ino, (0, 0))
    return fd
def root_stat(fd):
    st = original_fstat(fd)
    values = list(st)
    values[4:6] = owners.get(st.st_ino, (st.st_uid, st.st_gid))
    return os.stat_result(values)
def transfer(fd, uid, gid):
    st = original_fstat(fd)
    assert owners[st.st_ino] == (0, 0)
    owners[st.st_ino] = (uid, gid)
os.open, os.fstat, os.stat, os.fchown = root_open, root_stat, operator_stat, transfer
`;
    const after=`assert len(owners) == 3\nassert all(owner == operator for owner in owners.values()), owners`;
    const result=await pruneWithoutUidProcesses(before,after);expect(result.status,result.stderr).toBe(0);
    for(const [i,name] of names.entries()){
      const st=await fs.stat(join(root,'receipts','.'+name+'.writer'));
      expect(st.mode&0o777).toBe(0o600);if(mode==='persisted')expect(st.ino).toBe(inodes[i]);
    }
    for(const k of [1,2]){
      const p=await runner.prepare({nonce,slot:`forge-exec-${k}`});expect(p.slot).toBe(`forge-exec-${k}`);
    }
  });
  it.skipIf(process.platform!=='linux'||process.getuid()!==0)('root pruning permits real operator acquisition of every slot',async()=>{
    const uid=65534,gid=65534;
    await runner.telemetry();
    for(const path of [root,join(root,'runs'),join(root,'receipts'),join(root,'cache')])await fs.chown(path,uid,gid);
    for(const k of [1,2])await fs.chown(join(root,'runs',`slot-${k}`),uid,2000+k);
    const result=await pruneWithoutUidProcesses();expect(result.status,result.stderr).toBe(0);
    for(const name of ['worker-active','worker-active-1','worker-active-2']){
      const st=await fs.stat(join(root,'receipts','.'+name+'.writer'));
      expect(st.uid).toBe(uid);expect(st.gid).toBe(gid);expect(st.mode&0o777).toBe(0o600);
    }
    // Load the runner and enter the fixture before dropping privilege. Private
    // checkout/TMPDIR ancestors need not be traversable by the operator UID.
    const source=`import {createRunner} from ${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)};
process.chdir(process.argv[1]);
process.setgroups([]);process.setgid(${gid});process.setuid(${uid});
const runner=createRunner({testRoot:'.',testWorkerIdentity:user=>{
  const k=Number(user.split('-').at(-1));return {uid:1000+k,gid:2000+k,groups:[2000+k]};
}});
for(const k of [1,2]){
  const p=await runner.prepare({nonce:${JSON.stringify(nonce)},slot:'forge-exec-'+k});
  if(p.slot!=='forge-exec-'+k)throw new Error('Wrong reservation');
}`;
    const acquired=spawnSync(process.execPath,['--input-type=module','-e',source,root],
      {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    expect(acquired.status,acquired.stderr).toBe(0);
  });
  it.each(['foreign owner','non-private mode','symlink'])('prune refuses %s before transferring writer ownership',async fault=>{
    await runner.telemetry();
    const path=join(root,'receipts/.worker-active.writer');
    if(fault==='symlink'){
      const target=join(root,'foreign-writer');await fs.writeFile(target,'untouched',{mode:0o600});await fs.symlink(target,path);
    }else await fs.writeFile(path,'',{mode:fault==='non-private mode'?0o644:0o600});
    const before=String.raw`def forbidden_transfer(*args): raise AssertionError('untrusted inode was chowned')
os.fchown = forbidden_transfer
`+(fault==='foreign owner'?String.raw`original_fstat = os.fstat
def foreign_stat(fd):
    values = list(original_fstat(fd))
    values[4] = 1048576
    return os.stat_result(values)
os.fstat = foreign_stat
`:'');
    const result=await pruneWithoutUidProcesses(before);
    expect(result.status).not.toBe(0);expect(result.stderr).not.toContain('untrusted inode was chowned');
    expect(result.stderr).toContain(fault==='symlink'?'Too many levels':'unsafe worker writer guard');
    if(fault==='symlink')expect(await fs.readFile(join(root,'foreign-writer'),'utf8')).toBe('untouched');
  });
  it('excludes reclamation while an old reservation holder is paused before worker launch',async()=>{
    await fs.rm(join(root,'runs/slot-2'),{recursive:true});
    let reached,resume,paused=false;
    const ready=new Promise(resolve=>reached=resolve),release=new Promise(resolve=>resume=resolve),launches=[];
    runner=createRunner({testRoot:root,testPath:'/usr/bin:/bin',testWorkerExec:async({argv,worker})=>{
      if(!paused){paused=true;reached();await release;}
      if(argv[0]==='npm')launches.push(worker.uid);
      return {code:0};
    }});
    const a=await runner.prepare({nonce}),request=await requestFor(a),running=runner.run(request);
    try {
      await Promise.race([ready,running.then(()=>{throw new Error('Holder exited before the launch barrier');})]);
      const expired=new Date(Date.now()-16*86400000);
      const container=join(work(a),'../'),receipt=join(root,'receipts',a.run+'.running');
      for(const path of [lock(a),container,receipt])await fs.utimes(path,expired,expired);
      const writer=join(root,'receipts/.worker-active-1.writer'),inode=(await fs.stat(writer)).ino;
      await fs.utimes(writer,expired,expired);
      const unrelated=join(root,'receipts/unrelated.telemetry');await fs.writeFile(unrelated,'old');await fs.utimes(unrelated,expired,expired);
      const result=await pruneWithoutUidProcesses();
      expect(result.status,result.stderr).toBe(0);expect(result.stderr).not.toContain('abandoned reservation');
      for(const path of [lock(a),container,receipt])expect(await fs.stat(path)).toBeDefined();
      expect((await fs.stat(writer)).ino).toBe(inode);
      await expect(fs.stat(unrelated)).rejects.toMatchObject({code:'ENOENT'});
      const other=createRunner({testRoot:root,testPath:'/usr/bin:/bin',testWorkerExec:vi.fn()});
      await expect(other.prepare({nonce})).rejects.toMatchObject({code:'forge-busy'});
      expect(launches).toEqual([]);
    }finally{resume();await running;}
    expect(launches).toEqual([a.worker.uid,a.worker.uid]);
    await runner.finish({...a,nonce});
    const b=await runner.prepare({nonce});expect(b.worker.uid).toBe(a.worker.uid);
    expect((await runner.run(await requestFor(b))).code).toBe(0);
    await runner.finish({...b,nonce});
  });
  it('rejects a resumed stale controller after pruning and replacement reservation',async()=>{
    await fs.rm(join(root,'runs/slot-2'),{recursive:true});
    const calls=vi.fn(async()=>({code:0}));
    runner=createRunner({testRoot:root,testPath:'/usr/bin:/bin',testWorkerExec:calls});
    const a=await runner.prepare({nonce}),request=await requestFor(a),expired=new Date(Date.now()-16*86400000);
    await fs.utimes(lock(a),expired,expired);
    // Retain prepared evidence to require the reservation identity recheck,
    // rather than relying on receipt pruning to reject the stale controller.
    const result=await pruneWithoutUidProcesses();expect(result.status,result.stderr).toBe(0);
    expect(result.stderr).toContain('abandoned reservation worker-active-1');
    const b=await runner.prepare({nonce});expect(b.worker.uid).toBe(a.worker.uid);
    await expect(runner.run(request)).rejects.toThrow('Reservation mismatch');
    expect(calls).not.toHaveBeenCalled();
    expect((await runner.run(await requestFor(b))).code).toBe(0);
    await runner.finish({...b,nonce});
  });
  it.each(['acquire','launch','finish'])('prune exclusion blocks reservation %s until its stable guard is released',async operation=>{
    await fs.rm(join(root,'runs/slot-2'),{recursive:true});
    const calls=vi.fn(async()=>({code:0}));
    runner=createRunner({testRoot:root,testPath:'/usr/bin:/bin',testWorkerExec:calls});
    const a=await runner.prepare({nonce}),request=await requestFor(a);
    if(operation==='acquire')await runner.finish({...a,nonce});
    calls.mockClear();
    const guard=await fs.open(join(root,'receipts/.worker-active-1.writer'),'r+');
    try {
      const held=spawnSync('python3',['-I','-c','import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],{stdio:['ignore','pipe','pipe',guard.fd],timeout:10000});
      expect(held.status,held.stderr?.toString()).toBe(0);
      const attempted=operation==='acquire'?runner.prepare({nonce}):operation==='launch'?runner.run(request):runner.finish({...a,nonce});
      await expect(attempted).rejects.toMatchObject({code:'forge-busy'});expect(calls).not.toHaveBeenCalled();
      if(operation==='acquire')await expect(fs.stat(lock(a))).rejects.toMatchObject({code:'ENOENT'});
      else expect((await fs.stat(lock(a))).isDirectory()).toBe(true);
    }finally{await guard.close();}
    if(operation==='acquire'){
      const b=await runner.prepare({nonce});await runner.finish({...b,nonce});
    }else{
      if(operation==='launch')expect((await runner.run(request)).code).toBe(0);
      await runner.finish({...a,nonce});
    }
  });
  function supervisorProbe(config,script='') {
    const probe=String.raw`import ctypes, json, os, sys, subprocess, fcntl, errno
from unittest.mock import patch
source, config = sys.argv[1:]
cfg = json.loads(config)
real_popen = subprocess.Popen
def launch(*args, **kwargs):
    fd = os.open(cfg['writer']['guard'], os.O_RDWR)
    try:
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: pass
        else: raise AssertionError('supervisor lost its writer lease before launch')
    finally: os.close(fd)
    inherited = kwargs['pass_fds'][0]
    drop = kwargs['preexec_fn']
    def checked_drop():
        drop()
        try: os.fstat(inherited)
        except OSError as error: assert error.errno == errno.EBADF
        else: raise AssertionError('task inherited the writer guard descriptor')
    kwargs['preexec_fn'] = checked_drop
    return real_popen(*args, **kwargs)
`+script+String.raw`
with patch.object(ctypes, 'CDLL') as libc, patch.object(os, 'listdir', return_value=[]), patch.object(subprocess, 'Popen', side_effect=launch):
    libc.return_value.prctl.return_value = 0
    sys.argv = ['supervisor', config]
    exec(source)
`;
    return spawnSync('python3',['-I','-c',probe,supervisorSource,JSON.stringify(config)],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  }
  function supervisorConfig(p) {
    return {uid:process.getuid(),gid:process.getgid(),argv:['/usr/bin/true'],cwd:root,env:{},status:join(root,'supervisor-status'),
      writer:{run:p.run,nonce,slot:p.slot,guard:join(root,'receipts/.worker-active-1.writer'),reservation:join(lock(p),'reservation.json')}};
  }
  it('the root supervisor retains its own writer lease through fork and closes the child copy after UID drop',async()=>{
    const a=await runner.prepare({nonce}),result=supervisorProbe(supervisorConfig(a));
    expect(result.status,result.stderr).toBe(0);
    expect(await fs.readFile(join(root,'supervisor-status'),'utf8')).toBe('0');
  });
  it.each(['replacement reservation','exclusive prune lease','oversized reservation','non-private writer guard','missing writer evidence'])('the root supervisor refuses launch after %s',async fault=>{
    await fs.rm(join(root,'runs/slot-2'),{recursive:true});
    const a=await runner.prepare({nonce}),config=supervisorConfig(a);
    let guard;
    try {
      if(fault==='replacement reservation'){
        await runner.finish({...a,nonce});await runner.prepare({nonce});
      }else if(fault==='missing writer evidence'){
        delete config.writer;
      }else if(fault==='oversized reservation'){
        await fs.writeFile(config.writer.reservation,Buffer.alloc(4*1024*1024+1,'x'));
      }else if(fault==='non-private writer guard'){
        await fs.chmod(config.writer.guard,0o644);
      }else{
        guard=await fs.open(config.writer.guard,'r+');
        const held=spawnSync('python3',['-I','-c','import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'],{stdio:['ignore','pipe','pipe',guard.fd],timeout:10000});
        expect(held.status,held.stderr?.toString()).toBe(0);
      }
      const result=supervisorProbe(config,"def launch(*args, **kwargs):\n    with open(os.path.join(cfg['cwd'], 'launch-reached'), 'w') as marker: marker.write('launched')\n    raise AssertionError('worker launch was reached')\n");
      expect(result.status).not.toBe(0);
      const reasons={'replacement reservation':'Reservation mismatch','exclusive prune lease':'BlockingIOError',
        'oversized reservation':'unsafe worker reservation','non-private writer guard':'unsafe worker writer guard','missing writer evidence':"KeyError: 'writer'"};
      expect(result.stderr).toContain(reasons[fault]);
      await expect(fs.stat(join(root,'launch-reached'))).rejects.toMatchObject({code:'ENOENT'});
      await expect(fs.stat(config.status)).rejects.toMatchObject({code:'ENOENT'});
    }finally{await guard?.close();}
  });
  it('refuses a symlinked writer guard before reserving or launching a worker',async()=>{
    const p=await runner.prepare({nonce}),writer=join(root,'receipts/.worker-active-1.writer');
    await runner.finish({...p,nonce});
    await fs.rm(writer);const target=join(root,'foreign-guard');await fs.writeFile(target,'untouched');await fs.symlink(target,writer);
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code:'ELOOP'});
    expect(await fs.readFile(target,'utf8')).toBe('untouched');
    await expect(fs.stat(lock(p))).rejects.toMatchObject({code:'ENOENT'});
  });
  it.each([
    ['duplicate uid','Duplicate worker identity'],['duplicate gid','Duplicate worker identity'],
    ['operator uid','Worker must not share the operator identity'],['operator gid','Worker must not share the operator identity'],
    ['foreign owner','Untrusted slot directory'],['foreign group','Untrusted slot directory'],
    ['non-private worker group','Worker groups must be private'],
  ])('refuses production isolation violation: %s',async(fault,message)=>{
    const identity=user=>{
      const ids=workerIdentity(user);
      if(fault==='duplicate uid')ids.uid=workerIdentity('forge-exec-1').uid;
      if(fault==='duplicate gid')ids.gid=workerIdentity('forge-exec-1').gid;
      if(fault==='operator uid')ids.uid=process.getuid();
      if(fault==='operator gid')ids.gid=process.getgid();
      ids.groups=fault==='non-private worker group'?[ids.gid,ids.gid+1]:[ids.gid];
      return ids;
    };
    const stat=async path=>{
      const st=await slotStat(path);
      if(fault==='duplicate gid')st.gid=workerIdentity('forge-exec-1').gid;
      if(fault==='foreign owner')st.uid=process.getuid()+1;
      if(fault==='foreign group')st.gid++;
      return st;
    };
    runner=createRunner({testRoot:root,testPath:'/usr/bin:/bin',testWorkerIdentity:identity,testSlotStat:stat});
    await expect(runner.prepare({nonce})).rejects.toThrow(message);
    expect(await fs.readdir(join(root,'receipts'))).toEqual([]);
  });
  it('the actual supervisor UID scanner selects only A live processes and excludes B and zombies',()=>{
    const helper=supervisorSource.slice(supervisorSource.indexOf('def uid_processes():'),supervisorSource.indexOf('deadline ='));
    const probe=`import types, io, json\nuid=1001\ncfg={'reapUid':True}\nos=types.SimpleNamespace(listdir=lambda _:['11','22','33','not-a-pid'],getpid=lambda:99,stat=lambda path:types.SimpleNamespace(st_uid=1002 if path.endswith('/22') else 1001))\nopen=lambda path,mode:io.BytesIO(b'33 (zombie) Z 1' if '/33/' in path else b'11 (live) S 1')\n${helper}\nprint(json.dumps(sorted(uid_processes())))`;
    const result=spawnSync('python3',['-I','-c',probe],{encoding:'utf8',timeout:10000});
    expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout)).toEqual([11]);
  });
  it('runs two commands concurrently under separate UIDs and reaps only the finishing UID',async()=>{
    const calls=[],pending=[];
    runner=createRunner({testRoot:root,testPath:'/usr/bin:/bin',
      testWorkerIdentity:workerIdentity,testSlotStat:slotStat,
      testWorkerExec:async call=>{
        calls.push(call);
        if(call.argv[1]==='run')return new Promise(done=>pending.push(()=>done({code:0})));
        return {code:0};
      }});
    const a=await runner.prepare({nonce}),b=await runner.prepare({nonce}),requests=[];
    for(const p of [a,b]){
      const dir=work(p);await fs.writeFile(join(dir,'package-lock.json'),p.slot);
      const manifest=manifestWire({entries:[{path:Buffer.from('package-lock.json'),sha256:hash(p.slot),executable:false}],excluded:[]});
      const argv=['npm','run','test:unit'];
      requests.push({...p,nonce,argv,env:{},lock:hash(p.slot),manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(dir),argvDigest:digestArgv(argv)});
    }
    const running=requests.map(r=>runner.run(r));
    try {
      await vi.waitFor(()=>expect(pending).toHaveLength(2));
      const tasks=calls.filter(c=>c.argv[1]==='run');
      expect(tasks.map(c=>c.worker.uid).sort()).toEqual([workerIdentity('forge-exec-1').uid,workerIdentity('forge-exec-2').uid]);
      expect(tasks.map(c=>c.cwd).sort()).toEqual([work(a),work(b)].sort());
      expect(tasks.every(c=>[a.slot,b.slot].includes(c.worker.user))).toBe(true);
    }finally{for(const done of pending)done();await Promise.all(running);}
    const offset=calls.length;
    expect(await runner.finish({...a,nonce})).toMatchObject({code:0,phase:'test'});
    expect(calls.slice(offset)).toHaveLength(1);
    expect(calls[offset]).toMatchObject({argv:['/usr/bin/true'],worker:{user:a.slot,uid:a.worker.uid}});
    expect((await fs.stat(work(b))).isDirectory()).toBe(true);
    expect((await fs.stat(lock(b))).isDirectory()).toBe(true);
  });
  it('allocates distinct slots, identities, run roots and locks for concurrent prepares',async()=>{
    const [a,b]=await Promise.all([runner.prepare({nonce}),runner.prepare({nonce})]);
    expect(new Set([a.slot,b.slot]).size).toBe(2);
    expect(a.worker.uid).not.toBe(b.worker.uid);expect(a.worker.gid).not.toBe(b.worker.gid);
    expect(work(a)).not.toBe(work(b));
    for(const p of [a,b])expect((await fs.stat(lock(p))).mode&0o777).toBe(0o700);
  });
  it('keeps slot metadata operator-owned with only worker-group traversal and returns discovered identities',async()=>{
    const a=await runner.prepare({nonce}),b=await runner.prepare({nonce});
    for(const p of [a,b]){
      const st=await fs.stat(join(work(p),'../..'));
      expect(st.mode&0o777).toBe(0o710);
      expect(st.uid).toBe(process.getuid());expect(st.gid).toBe(process.getgid());
      expect(p.worker).toMatchObject({user:p.slot,uid:expect.any(Number),gid:expect.any(Number)});
      expect(p.capabilities.workers).toEqual(['forge-exec-1','forge-exec-2']);
    }
    expect(a.worker.uid).not.toBe(b.worker.uid);
  });
  it('keeps every receipt under the ops-only 0700 root outside worker roots',async()=>{
    const a=await runner.prepare({nonce});
    expect((await fs.stat(join(root,'receipts'))).mode&0o777).toBe(0o700);
    const record=JSON.parse(await fs.readFile(join(root,'receipts',a.run+'.prepared')));
    expect(record.slot).toBe(a.slot);
    expect(JSON.stringify(a.worker)).not.toContain('receipts');
    expect((await fs.stat(join(root,'receipts',a.run+'.prepared'))).mode&0o777).toBe(0o600);
  });
  it('finishing A removes only A and leaves B reservation and files intact',async()=>{
    const a=await runner.prepare({nonce}),b=await runner.prepare({nonce});
    await fs.writeFile(join(work(b),'keep'),'B');
    await runner.finish({...a,nonce});
    await expect(fs.stat(work(a))).rejects.toMatchObject({code:'ENOENT'});
    expect(await fs.readFile(join(work(b),'keep'),'utf8')).toBe('B');
    expect((await fs.stat(lock(b))).isDirectory()).toBe(true);
  });
  it('returns forge-busy when every discovered slot is reserved',async()=>{
    await runner.prepare({nonce});await runner.prepare({nonce});
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code:'forge-busy'});
  });
  it('bounds discovery at 128 identities with an explicit local fallback',async()=>{
    for(let k=3;k<=129;k++)await fs.mkdir(join(root,'runs',`slot-${k}`),{mode:0o700});
    await expect(runner.prepare({nonce})).rejects.toThrow('Worker pool exceeds 128 slots; use local fallback');
    expect(await fs.readdir(join(root,'receipts'))).toEqual([]);
  });
  it('refuses readable receipts and leaves existing reservations closed',async()=>{
    const a=await runner.prepare({nonce});await fs.chmod(join(root,'receipts'),0o755);
    await expect(runner.prepare({nonce})).rejects.toThrow('Receipts must be ops-only');
    expect((await fs.stat(lock(a))).isDirectory()).toBe(true);
  });
  it('generates an exact rsync Runas list without a wildcard user',async()=>{
    const setup=await fs.readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    const body=setup.slice(setup.indexOf("{\n  printf 'ops ALL=('"),setup.indexOf('} > "$sudoers_pending"')+1);
    const result=spawnSync('bash',['-c','FORGE_EXEC_SLOTS=2\n'+body],{encoding:'utf8',timeout:10000});
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toBe([
      'ops ALL=(forge-exec-1,forge-exec-2) NOPASSWD: /usr/bin/rsync',
      'ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs',
      'ops ALL=(root) NOPASSWD: /usr/local/libexec/forge-exec-run.mjs *',
      '',
    ].join('\n'));
    expect(result.stdout).not.toContain('(ALL)');expect(result.stdout).not.toContain('(forge-exec-*)');
    expect(result.stdout).not.toContain('SETENV');
  });
  it.each([true,false])('validates sudoers before installing root:root 0440 (visudo accepts: %s)',async valid=>{
    const setup=await fs.readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    const install=setup.slice(setup.indexOf('visudo -cf "$sudoers_pending"'),setup.indexOf('trap - EXIT'));
    const pending=join(root,'sudoers.pending');await fs.writeFile(pending,'fixture',{mode:0o600});
    const result=spawnSync('bash',['-c',`
set -euo pipefail
sudoers_pending=$1
visudo() { printf 'visudo:%s\\n' "$*"; return ${valid?0:1}; }
chown() { printf 'chown:%s\\n' "$*"; }
chmod() { printf 'chmod:%s\\n' "$*"; command chmod "$@"; }
mv() { printf 'mv:%s\\n' "$*"; }
${install}
`,'fixture',pending],{encoding:'utf8',timeout:10000});
    expect(result.status,result.stderr).toBe(valid?0:1);
    expect(result.stdout).toBe([
      `visudo:-cf ${pending}`,
      ...(valid?[`chown:root:root ${pending}`,`chmod:440 ${pending}`,`mv:-f -- ${pending} /etc/sudoers.d/forge-exec`]:[]),
      '',
    ].join('\n'));
    expect((await fs.stat(pending)).mode&0o777).toBe(valid?0o440:0o600);
  });
  it.each([2,3])('refuses shrinking an installed three-slot pool to %s slots',async slots=>{
    const setup=await fs.readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    // Exercise the shipped guard against a private pool, before user creation
    // or privileged setup can run. Only the installation path is redirected.
    const guard=setup.slice(setup.indexOf('set -euo pipefail'),setup.indexOf('if ! id forge-exec'))
      .replaceAll('/srv/forge-exec',root);
    await fs.mkdir(join(root,'slot-3'));
    const result=spawnSync('bash',['-c',guard+'\nprintf "setup-continues\\n"'],{
      encoding:'utf8',timeout:10000,env:{...process.env,FORGE_EXEC_SLOTS:String(slots)},
    });
    expect(result.status,result.stderr).toBe(slots===2?1:0);
    expect(result.stderr).toBe(slots===2?'forge-setup: cannot shrink an installed pool; retain its slot count and inspect reservations\n':'');
    expect(result.stdout).toBe(slots===2?'':'setup-continues\n');
  });
  it('rejects client-selected identities outside the discovered pool',async()=>{
    for(const slot of ['root','forge-exec-3','forge-exec-01','../slot-1'])
      await expect(runner.prepare({nonce,slot})).rejects.toThrow('Invalid slot');
    const a=await runner.prepare({nonce});
    await expect(runner.finish({...a,nonce,slot:'forge-exec-2'})).rejects.toThrow('Slot mismatch');
  });
  it('never releases a reservation replaced with another run identity',async()=>{
    const a=await runner.prepare({nonce}),b=await runner.prepare({nonce});
    await fs.writeFile(join(lock(a),'reservation.json'),JSON.stringify({run:b.run,nonce,slot:a.slot}));
    await expect(runner.finish({...a,nonce})).rejects.toThrow('Reservation mismatch');
    expect((await fs.stat(lock(a))).isDirectory()).toBe(true);
    expect((await fs.stat(lock(b))).isDirectory()).toBe(true);
  });
  it('preserves the legacy single-user path when no pool directories exist',async()=>{
    await fs.rm(join(root,'runs'),{recursive:true});
    const a=await runner.prepare({nonce});
    expect(a.slot??'forge-exec').toBe('forge-exec');
    expect((await fs.stat(join(root,'runs',a.run,'work'))).isDirectory()).toBe(true);
    expect(await runner.finish({...a,nonce})).toBeNull();
  });
  it('never ages out an interrupted reservation and rejects permissive slot roots',async()=>{
    const a=await runner.prepare({nonce}),b=await runner.prepare({nonce});
    const old=new Date(0);await fs.utimes(lock(a),old,old);await fs.utimes(lock(b),old,old);
    await expect(runner.prepare({nonce})).rejects.toMatchObject({code:'forge-busy'});
    await fs.chmod(join(root,'runs','slot-1'),0o755);
    await expect(runner.prepare({nonce})).rejects.toThrow('Untrusted slot directory');
  });
  it('refuses the previous worker-owned 0700 layout until setup is redeployed',async()=>{
    await fs.chmod(join(root,'runs','slot-1'),0o700);
    await expect(runner.prepare({nonce})).rejects.toThrow('redeploy forge-setup and use local fallback');
  });
  it('does not free an executing or uncertain slot on finish',async()=>{
    const a=await runner.prepare({nonce});
    await fs.mkdir(join(lock(a),'executing'));
    await expect(runner.finish({...a,nonce})).rejects.toThrow('execution unconfirmed');
    expect((await fs.stat(lock(a))).isDirectory()).toBe(true);
  });
});

describe('anonymous real Git snapshot',()=>{
  const git=(cwd,...args)=>{
    const result=spawnSync('git',args,{cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});
    if(result.status!==0)throw new Error(result.stderr);return result.stdout.trim();
  };
  it.each([false,true])('preserves Mac HEAD behind public main and the real failing coverage scope (delta=%s)',async delta=>{
    const source=join(root,'public'),baseRoot=join(root,'bases');
    await fs.mkdir(source);await fs.mkdir(baseRoot);
    git(source,'init','-b','main');git(source,'config','user.name','Fixture');git(source,'config','user.email','f@example.invalid');
    const tier='scripts/lib/disposition-judge.mjs';
    await fs.mkdir(join(source,'scripts/lib'),{recursive:true});
    await fs.writeFile(join(source,tier),'export const changed = false;\n');
    await fs.writeFile(join(source,'package-lock.json'),'lock');
    await fs.writeFile(join(source,'head-only.txt'),'retained from Mac HEAD');
    git(source,'add','.');git(source,'commit','-m','Mac HEAD');
    const head=git(source,'rev-parse','HEAD');
    await fs.writeFile(join(source,tier),'export const changed = true;\n');
    git(source,'rm','head-only.txt');await fs.writeFile(join(source,'main-only.txt'),'public main');
    git(source,'add','.');git(source,'commit','-m','public tier change');
    const main=git(source,'rev-parse','HEAD');
    git(root,'clone','--bare',source,join(baseRoot,'repo.git'));
    git(join(baseRoot,'repo.git'),'update-ref','refs/remotes/origin/main',main);
    const {buildDeltaManifest}=await import('../remote-exec.mjs');
    const exec=async call=>{const r=spawnSync(call.file,call.args,{cwd:call.cwd});return {code:r.status,stdout:r.stdout};};
    const baseSnapshot=await buildManifest({cwd:source,exec});
    const baseManifest=manifestWire(baseSnapshot);
    const base={sha:main,manifest:baseManifest,manifestDigest:digestManifest(baseManifest)};
    const cache=join(baseRoot,main);await fs.mkdir(join(cache,'tree'),{recursive:true});
    for(const entry of baseSnapshot.entries){
      const to=join(cache,'tree',entry.path.toString());await fs.mkdir(join(to,'..'),{recursive:true});await fs.copyFile(join(source,entry.path.toString()),to);
    }
    await fs.writeFile(join(cache,'manifest.json'),JSON.stringify(baseManifest));
    await fs.writeFile(join(cache,'READY'),JSON.stringify({sha:main,manifestDigest:base.manifestDigest,lockDigest:hash('lock'),readyAtMs:1,fetchedAtMs:1}));
    git(source,'checkout','--detach',head);
    await fs.writeFile(join(source,tier),'export const changed = true;\n');
    const loc={start:{line:1,column:0},end:{line:1,column:40}};
    const coverage=JSON.stringify({[tier]:{branchMap:{0:{loc,locations:[loc,loc]}},b:{0:[0,0]}}});
    await fs.appendFile(join(source,'.git/info/exclude'),'\ncoverage/\n');
    await fs.mkdir(join(source,'coverage'));await fs.writeFile(join(source,'coverage/coverage-final.json'),coverage);
    const local=scanMaterializedGuards(source).coverage;
    expect(local).toMatchObject({status:'fail',total:2,exercised:0});
    const snapshot=delta?await buildDeltaManifest({cwd:source,exec,base,head}):await buildManifest({cwd:source,exec,head});
    expect(snapshot.entries.map(e=>e.path.toString())).toContain('head-only.txt');
    expect(snapshot.entries.map(e=>e.path.toString())).not.toContain('main-only.txt');
    expect(manifestWire(snapshot)).toEqual(manifestWire(await buildManifest({cwd:source,exec})));
    const commands=[],gitCalls=[];
    runner=createRunner({testRoot:root,testPath:process.env.PATH,
      testGitExec:async call=>{gitCalls.push(call);return cachedPublicGitExec(call);},
      testWorkerExec:async call=>{
        commands.push(call.argv);
        if(call.argv[2]==='check:standards'){
          expect(git(call.cwd,'rev-parse','HEAD')).toBe(head);
          expect(git(call.cwd,'rev-parse','origin/main')).toBe(main);
          expect(git(call.cwd,'diff','--cached','--name-only')).toBe(tier);
          expect(scanMaterializedGuards(call.cwd).coverage).toEqual(local);
          return {code:1};
        }
        return {code:0};
      }});
    const evidence={baseSha:main,baseManifestDigest:base.manifestDigest};
    const p=await runner.prepare({nonce,...(delta?evidence:{})}),dir=work(p),argv=['npm','run','check:standards'];
    for(const path of delta?snapshot.deltaPaths:snapshot.entries.map(e=>e.path)){
      const to=join(dir,path.toString());await fs.mkdir(join(to,'..'),{recursive:true});await fs.cp(join(source,path.toString()),to,{preserveTimestamps:true});
    }
    // Bind the full tree before transport; the cache merely avoids copying bytes.
    const full=join(root,'full');await fs.mkdir(full);
    for(const entry of snapshot.entries){const to=join(full,entry.path.toString());await fs.mkdir(join(to,'..'),{recursive:true});await fs.copyFile(join(source,entry.path.toString()),to);}
    const manifest={...manifestWire(snapshot),git:{head}};
    const request={...p,nonce,argv,env:{},lock:hash('lock'),manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(full),argvDigest:digestArgv(argv),
      ...(delta?{...evidence,deletions:Buffer.concat(snapshot.deletions.flatMap(p=>[p,Buffer.from([0])])).toString('base64')}:{})};
    const result=await runner.run(request);
    expect(result,result.stderr).toMatchObject({code:1});
    expect(commands.some(args=>args[2]==='check:standards')).toBe(true);
    expect(git(dir,'rev-parse','HEAD')).toBe(head);
    expect(gitCalls.some(call=>call.args.includes('fetch')&&call.args.at(-1)===head)).toBe(true);
    expect(await runner.finish(request)).toMatchObject({phase:'test',code:1});
  });
  it.each(['HEAD ancestor','main ancestor','missing','cached unrelated','mismatch','ref instead of SHA'])
  ('binds the coverage base SHA and requires public reachability before execution: %s',async scenario=>{
    const source=join(root,'public'),baseRoot=join(root,'bases');
    await fs.mkdir(source);await fs.mkdir(baseRoot);
    git(source,'init','-b','main');git(source,'config','user.name','Fixture');git(source,'config','user.email','f@example.invalid');
    await fs.writeFile(join(source,'package-lock.json'),'lock');git(source,'add','.');git(source,'commit','-m','initial');
    const initial=git(source,'rev-parse','HEAD');
    git(source,'commit','--allow-empty','-m','public main');
    const main=git(source,'rev-parse','HEAD');
    git(source,'checkout','--orphan','private-base');git(source,'commit','-m','unrelated cached commit');
    const unrelated=git(source,'rev-parse','HEAD');git(source,'checkout','main');
    git(root,'clone','--bare',source,join(baseRoot,'repo.git'));
    git(join(baseRoot,'repo.git'),'update-ref','refs/remotes/origin/main',scenario==='HEAD ancestor'?initial:main);
    const head=scenario==='main ancestor'?initial:main;
    const base=scenario==='missing'?'f'.repeat(40):scenario==='cached unrelated'?unrelated:scenario==='ref instead of SHA'?'main':main;
    const execute=vi.fn(async()=>({code:0})),gitExec=vi.fn(cachedPublicGitExec);
    runner=createRunner({testRoot:root,testPath:process.env.PATH,testWorkerExec:execute,testGitExec:gitExec});
    const p=await runner.prepare({nonce}),dir=work(p),argv=['npm','run','check:standards'];
    await fs.writeFile(join(dir,'package-lock.json'),'lock');
    const manifest={...manifestWire({entries:[{path:Buffer.from('package-lock.json'),sha256:hash('lock'),executable:false,tracked:true}],excluded:[]}),git:{head,diffCoverageBase:base}};
    const request={...p,nonce,argv,env:{DIFF_COVERAGE_BASE:scenario==='mismatch'?initial:base},
      manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(dir),lock:hash('lock'),argvDigest:digestArgv(argv)};
    if(scenario.endsWith('ancestor')) {
      expect(await runner.run(request)).toMatchObject({code:0});
      expect(git(dir,'rev-parse',base+'^{commit}')).toBe(base);
      expect(execute.mock.calls.find(([call])=>call.argv[2]==='check:standards')[0].env.DIFF_COVERAGE_BASE).toBe(base);
      expect(await runner.finish(request)).toMatchObject({phase:'test',code:0});
    } else {
      await expect(runner.run(request)).rejects.toThrow(scenario==='mismatch'?'Coverage base mismatch':scenario==='ref instead of SHA'?'Invalid Git evidence':'Coverage base unavailable');
      expect(execute).not.toHaveBeenCalled();
      await expect(fs.stat(join(dir,'.git'))).rejects.toMatchObject({code:'ENOENT'});
      const receipt=await runner.finish(request);
      if(['missing','cached unrelated'].includes(scenario))expect(receipt).toMatchObject({phase:'rejected',reason:'diff-coverage-base-unavailable',started:false});
      else expect(receipt).toBeNull(); // Generic snapshot rejection retains the legacy fail-closed contract.
      if(scenario==='mismatch')expect(gitExec).not.toHaveBeenCalled();
    }
  });
  it.each([false,true])('certifies an unfetchable Mac HEAD as not-started git-head-unavailable without install or task execution (delta=%s)',async delta=>{
    const source=join(root,'public'),baseRoot=join(root,'bases');await fs.mkdir(source);await fs.mkdir(baseRoot);
    git(source,'init','-b','main');await fs.writeFile(join(source,'package-lock.json'),'lock');git(source,'add','.');
    git(source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','public');
    const main=git(source,'rev-parse','HEAD');git(root,'clone','--bare',source,join(baseRoot,'repo.git'));
    git(join(baseRoot,'repo.git'),'update-ref','refs/remotes/origin/main',main);
    git(source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','--allow-empty','-m','unpushed Mac HEAD');
    const head=git(source,'rev-parse','HEAD');
    const baseManifest=manifestWire({entries:[{path:Buffer.from('package-lock.json'),sha256:hash('lock'),executable:false,tracked:true}],excluded:[]});
    const evidence={baseSha:main,baseManifestDigest:digestManifest(baseManifest)};
    if(delta){
      const cache=join(baseRoot,main);await fs.mkdir(join(cache,'tree'),{recursive:true});
      await fs.writeFile(join(cache,'tree/package-lock.json'),'lock');
      await fs.writeFile(join(cache,'manifest.json'),JSON.stringify(baseManifest));
      await fs.writeFile(join(cache,'READY'),JSON.stringify({sha:main,manifestDigest:evidence.baseManifestDigest,lockDigest:hash('lock'),readyAtMs:1,fetchedAtMs:1}));
    }
    const execute=vi.fn(async()=>({code:0})),gitCalls=[];
    runner=createRunner({testRoot:root,testPath:process.env.PATH,testWorkerExec:execute,
      testGitExec:async call=>{gitCalls.push(call);return cachedPublicGitExec(call);}});
    const p=await runner.prepare({nonce,...(delta?evidence:{})}),dir=work(p),argv=['npm','run','check:standards'];
    await fs.writeFile(join(dir,'package-lock.json'),'lock');
    const manifest={...baseManifest,git:{head}};
    const request={...p,nonce,argv,env:{},lock:hash('lock'),manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(dir),argvDigest:digestArgv(argv),
      ...(delta?{...evidence,deletions:''}:{})};
    await expect(runner.run(request)).rejects.toMatchObject({code:'git-head-unavailable'});
    expect(execute).not.toHaveBeenCalled();
    expect(gitCalls.some(call=>call.args.includes('fetch')&&call.args.at(-1)===head)).toBe(true);
    await expect(fs.stat(join(dir,'.git'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await runner.finish(request)).toMatchObject({phase:'rejected',reason:'git-head-unavailable',started:false});
    expect(execute.mock.calls.every(([call])=>call.argv[0]==='/usr/bin/true')).toBe(true);
  });
  it.each(['fetch','cat-file','update-ref','read-tree','hash-object','update-index','wrong HEAD','throw'])('refuses %s failure even with Mac HEAD already in the warm mirror',async fault=>{
    const source=join(root,'public'),dir=join(root,'snapshot');await fs.mkdir(source);await fs.mkdir(dir);
    git(source,'init','-b','main');await fs.writeFile(join(source,'tracked.txt'),'base');git(source,'add','.');
    git(source,'-c','user.name=Fixture','-c','user.email=f@example.invalid','commit','-m','public');
    const head=git(source,'rev-parse','HEAD');git(root,'clone','--bare',source,join(root,'repo.git'));
    git(join(root,'repo.git'),'update-ref','refs/remotes/origin/main',head);
    await fs.writeFile(join(dir,'tracked.txt'),'changed');
    const manifest={...manifestWire({entries:[{path:Buffer.from('tracked.txt'),sha256:hash('changed'),executable:false,tracked:true}],excluded:[]}),git:{head}};
    const commands=[];
    await expect(bases.materializeWorktree({work:dir,root,head,manifest,manifestDigest:digestManifest(manifest),exec:async call=>{
      commands.push(call);
      if(fault==='throw'&&call.args.includes('fetch'))throw new Error('transport unavailable');
      if(call.args.includes(fault))return {code:1,stdout:Buffer.alloc(0)};
      if(fault==='wrong HEAD'&&call.args.includes('rev-parse')&&call.args.at(-1)==='HEAD')return {code:0,stdout:Buffer.from('f'.repeat(40))};
      return cachedPublicGitExec(call);
    }})).rejects.toMatchObject({code:'git-head-unavailable'});
    expect(commands.some(call=>call.args.includes('fetch'))).toBe(true);
    await expect(fs.stat(join(dir,'.git'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await fs.readdir(root)).some(name=>name.startsWith('.git-run-'))).toBe(false);
  });
  it('refuses a caller HEAD differing from hash-bound manifest HEAD before invoking Git',async()=>{
    const manifest={...manifestWire({entries:[],excluded:[]}),git:{head:'a'.repeat(40)}},exec=vi.fn();
    await expect(bases.materializeWorktree({work:root,root,head:'b'.repeat(40),manifest,manifestDigest:digestManifest(manifest),exec})).rejects.toThrow('Invalid Git evidence');
    expect(exec).not.toHaveBeenCalled();
  });
  it('keeps exact Mac HEAD, stages tracked bytes and deletions, and leaves Mac untracked files untracked',async()=>{
    const source=join(root,'source'),snapshot=join(root,'snapshot');
    await fs.mkdir(source);await fs.mkdir(snapshot);
    git(source,'init','-b','main');git(source,'config','user.name','Fixture');git(source,'config','user.email','fixture@example.invalid');
    await fs.writeFile(join(source,'old'),'base');await fs.writeFile(join(source,'untracked'),'formerly tracked');
    git(source,'add','.');git(source,'commit','-m','base');
    const head=git(source,'rev-parse','HEAD');
    // The warmer initializes a bare repo and fetches only origin/main. Its
    // default HEAD can remain unborn: it has no refs/heads/main to clone.
    const mirror=join(root,'repo.git');git(root,'clone','--bare',source,mirror);
    git(mirror,'update-ref','refs/remotes/origin/main',head);
    git(mirror,'update-ref','-d','refs/heads/main');
    const files=[['.gitattributes','* text eol=lf\n'],['new','changed\r\n'],['untracked','public']];
    const entries=files.map(([name,value])=>({path:Buffer.from(name),sha256:hash(value),executable:false,tracked:name!=='untracked'}));
    for(const [name,value] of files)await fs.writeFile(join(snapshot,name),value);
    const manifest={...manifestWire({entries,excluded:[]}),git:{head}};
    expect(typeof bases.materializeWorktree).toBe('function');
    const commands=[];
    await bases.materializeWorktree({work:snapshot,root,baseSha:head,head,manifest,manifestDigest:digestManifest(manifest),exec:async call=>{
      commands.push(call);
      // Only the operator's protected clone and mirror may be trusted, even
      // when Git simulates an ownership mismatch. No Git runs in the snapshot.
      const env=call.cwd===root?call.env:{...call.env,GIT_TEST_ASSUME_DIFFERENT_OWNER:'1'};
      return cachedPublicGitExec({...call,env});
    }});
    for(const command of commands){
      expect(command.env).toEqual(bases.anonymousGitEnv());
      expect(Object.keys(command.env).some(key=>/token|secret|password|ssh_auth|proxy/i.test(key))).toBe(false);
      expect(command.args.filter(a=>a.includes('://')).every(url=>url===bases.PUBLIC_REPOSITORY)).toBe(true);
      expect(command.cwd).not.toBe(snapshot);
      expect(command.args).not.toContain('safe.directory='+snapshot);
    }
    expect((await fs.stat(join(snapshot,'.git'))).isDirectory()).toBe(true);
    expect(git(snapshot,'rev-parse','origin/main')).toBe(head);
    expect(git(snapshot,'rev-parse','HEAD')).toBe(head);
    expect(git(snapshot,'ls-tree','--name-only','HEAD').split('\n')).toEqual(['old','untracked']);
    expect(git(snapshot,'diff','--cached','--name-status')).toContain('D\told');
    expect(git(snapshot,'diff','--cached','--name-status')).toContain('D\tuntracked');
    await expect(fs.stat(join(snapshot,'old'))).rejects.toMatchObject({code:'ENOENT'});
    expect(git(snapshot,'ls-files','--others','--exclude-standard')).toBe('untracked');
    expect(spawnSync('git',['show',':new'],{cwd:snapshot}).stdout.equals(Buffer.from('changed\r\n'))).toBe(true);
    expect(git(snapshot,'remote','get-url','origin')).toBe('https://github.com/chalbert/web-everything.git');
    expect(git(snapshot,'config','--get','remote.origin.fetch')).toContain('refs/remotes/origin/');
    expect(git(snapshot,'rev-list','--count','HEAD')).toBe('1');
    expect(commands.some(c=>c.args.includes('commit-tree'))).toBe(false);
  });
  it('refuses incomplete Git evidence before installing or running the gate',async()=>{
    const a=await runner.prepare({nonce}),dir=work(a),argv=['npm','run','check:standards'];
    await fs.writeFile(join(dir,'package-lock.json'),'lock');
    const manifest=manifestWire({entries:[{path:Buffer.from('package-lock.json'),sha256:hash('lock'),executable:false}],excluded:[]});
    await expect(runner.run({...a,nonce,argv,env:{},lock:hash('lock'),manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(dir),argvDigest:digestArgv(argv)})).rejects.toThrow('Git evidence');
  });
  it('refuses tracking-bit forgery before cloning or installing Git metadata',async()=>{
    const dir=join(root,'snapshot');await fs.mkdir(dir);await fs.writeFile(join(dir,'report.md'),'report');
    const manifest=manifestWire({entries:[{path:Buffer.from('report.md'),sha256:hash('report'),executable:false,tracked:false}],excluded:[]});
    const manifestDigest=digestManifest(manifest),exec=vi.fn();manifest.tracked[0]=true;
    await expect(bases.materializeWorktree({work:dir,root,head:'a'.repeat(40),manifest,manifestDigest,exec})).rejects.toThrow('Invalid Git evidence');
    expect(exec).not.toHaveBeenCalled();
    await expect(fs.stat(join(dir,'.git'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('uses exact public Mac HEAD even when the warm cache base is outside main ancestry',async()=>{
    const source=join(root,'source'),dir=join(root,'snapshot');await fs.mkdir(source);await fs.mkdir(dir);
    git(source,'init','-b','main');git(source,'config','user.name','Fixture');git(source,'config','user.email','f@example.invalid');
    await fs.writeFile(join(source,'old'),'base');git(source,'add','.');git(source,'commit','-m','main');
    const head=git(source,'rev-parse','HEAD');
    git(source,'checkout','--orphan','other');git(source,'commit','-m','unrelated');
    const baseSha=git(source,'rev-parse','HEAD');
    git(root,'clone','--bare',source,join(root,'repo.git'));
    git(join(root,'repo.git'),'update-ref','refs/remotes/origin/main',head);
    const manifest={...manifestWire({entries:[],excluded:[]}),git:{head}};
    await bases.materializeWorktree({work:dir,root,baseSha,head,manifest,manifestDigest:digestManifest(manifest),exec:cachedPublicGitExec});
    expect(git(dir,'rev-parse','HEAD')).toBe(head);
    expect(git(dir,'rev-parse','origin/main')).toBe(head);
    expect(git(dir,'diff','--cached','--name-status')).toBe('D\told');
  });
  it.each([false,true])('runs the real standards guards on a materialized snapshot (delta=%s) with a failing bound receipt',async delta=>{
    const baseRoot=join(root,'bases'),source=join(root,'public');await fs.mkdir(baseRoot);await fs.mkdir(source);
    git(source,'init','-b','main');git(source,'config','user.name','Fixture');git(source,'config','user.email','f@example.invalid');
    await fs.writeFile(join(source,'old'),'base');git(source,'add','.');git(source,'commit','-m','base');
    const head=git(source,'rev-parse','HEAD');git(root,'clone','--bare',source,join(baseRoot,'repo.git'));
    git(join(baseRoot,'repo.git'),'update-ref','refs/remotes/origin/main',head);
    let executed=false;
    runner=createRunner({testRoot:root,testPath:process.env.PATH,testGitExec:cachedPublicGitExec,testWorkerExec:async({argv,cwd,worker,env})=>{
      expect(worker.user).toMatch(/^forge-exec-[12]$/);
      if(argv[2]==='check:standards'){
        executed=true;
        expect(git(cwd,'rev-parse','origin/main')).toBe(head);
        expect(git(cwd,'rev-parse','HEAD')).toBe(head);
        const {coverage,artifacts}=scanMaterializedGuards(cwd);
        expect(coverage.status).toBe('fail');
        expect(coverage.errors[0].descriptor.kind).toBe('diff-branch-coverage');
        expect(artifacts.errors.map(e=>e.descriptor.file)).toEqual(['reports']);
        return {code:1};
      }
      return {code:0};
    }});
    const baseManifest=manifestWire({entries:[{path:Buffer.from('old'),sha256:hash('base'),executable:false,tracked:true}],excluded:[]});
    const baseEvidence={baseSha:head,baseManifestDigest:digestManifest(baseManifest)};
    if(delta){
      const base=join(baseRoot,head);await fs.mkdir(join(base,'tree'),{recursive:true});
      await fs.writeFile(join(base,'tree','old'),'base');
      await fs.writeFile(join(base,'manifest.json'),JSON.stringify(baseManifest));
      await fs.writeFile(join(base,'READY'),JSON.stringify({sha:head,manifestDigest:baseEvidence.baseManifestDigest,lockDigest:hash('lock'),readyAtMs:1,fetchedAtMs:1}));
    }
    const a=await runner.prepare({nonce,...(delta?baseEvidence:{})}),dir=work(a),argv=['npm','run','check:standards','--','--local','--files=package-lock.json'];
    const files=[['package-lock.json','lock'],['reports/new.md','new report'],['scripts/lib/disposition-judge.mjs','export const changed = true;\n']];
    for(const [name,content] of files){await fs.mkdir(join(dir,name,'..'),{recursive:true});await fs.writeFile(join(dir,name),content);}
    const manifest={...manifestWire({entries:files.map(([name,content])=>({path:Buffer.from(name),sha256:hash(content),executable:false,tracked:!name.startsWith('reports/')})),excluded:[]}),git:{head}};
    const request={...a,nonce,argv,env:{},lock:hash('lock'),manifest,manifestDigest:digestManifest(manifest),inputDigest:await digestInput(dir),argvDigest:digestArgv(argv),
      ...(delta?{...baseEvidence,deletions:Buffer.from('old\0').toString('base64')}:{})};
    expect(await runner.run(request)).toMatchObject({code:1});
    expect(executed).toBe(true);
    expect(await runner.finish(request)).toMatchObject({manifestDigest:digestManifest(manifest),phase:'test',code:1});
  });
  it('uses only public HTTPS when the mirror is absent and refuses failed clone evidence',async()=>{
    const dir=join(root,'snapshot');await fs.mkdir(dir);
    const manifest={...manifestWire({entries:[],excluded:[]}),git:{head:'a'.repeat(40)}},commands=[];
    await expect(bases.materializeWorktree({work:dir,root,head:'a'.repeat(40),manifest,manifestDigest:digestManifest(manifest),exec:async call=>{
      commands.push(call);return {code:1,stdout:''};
    }})).rejects.toThrow('use local fallback');
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toContain(bases.PUBLIC_REPOSITORY);
    expect(commands[0].env).toEqual(bases.anonymousGitEnv());
    await expect(fs.stat(join(dir,'.git'))).rejects.toMatchObject({code:'ENOENT'});
  });
});
