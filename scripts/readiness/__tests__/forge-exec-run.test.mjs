// @vitest-environment node
import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, readdir, utimes, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createRunner, digestInput, digestArgv, supervisorSource} from '../forge-exec-run.mjs';
let root, runner, request, work;
const argv = ['npm','run','test:unit','--','two words',"a'b",'$(touch marker)','line\nbreak'];
const hash = data => createHash('sha256').update(data).digest('hex');
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(process.env.TMPDIR,'forge-wrapper-')));
  const bin = join(root,'bin');
  await mkdir(bin);
  await symlink(process.execPath,join(bin,'node'));
  await writeFile(join(bin,'npm'), `#!/bin/bash
if [ "$1" = ci ]; then
  printf '%s\n' "$*|$NODE_ENV|$HOME" >> '${root}/install.log'
  if [ -f fail-install ]; then echo INJECTED_INSTALL_FAILURE >&2; exit 1; fi
  mkdir -p node_modules packages/deep/node_modules
  echo dev > node_modules/vitest
  echo nested > packages/deep/node_modules/dependency
  exit 0
fi
[ -f node_modules/vitest ] || exit 98
[ -f packages/deep/node_modules/dependency ] || exit 99
cat > stdin-seen
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' "$@" > argv-seen
printf '%s\n' "$*|$NODE_ENV" > task-seen
echo forged > .exit-code
echo '{"phase":"test","code":0}' > receipt.json
exit 3
`, {mode:0o755});
  runner = createRunner({testRoot:root,testPath:bin+':/usr/bin:/bin'});
  const prepared = await runner.prepare({nonce:'b'.repeat(32),label:'abcdef-1'});
  work = join(root,'runs',prepared.run,'work');
  await writeFile(join(work,'package-lock.json'),'lock');
  request = {nonce:'b'.repeat(32),run:prepared.run,argv,env:{NODE_ENV:'production',CI:'true'},lock:hash('lock'),
    inputDigest:await digestInput(work),argvDigest:digestArgv(argv)};
});
afterEach(async () => {await rm(root,{recursive:true,force:true});});
describe('fixed wrapper security boundary', () => {
  it('rejects dual lockfiles before a cold install and leaves the next lock-only run cold', async () => {
    await writeFile(join(work,'npm-shrinkwrap.json'),'shrinkwrap');
    request.inputDigest = await digestInput(work);
    const first = await runner.run(request).then(value=>({value}),error=>({error:error.message}));
    const installsBefore = await readFile(join(root,'install.log'),'utf8').catch(()=> '');
    await runner.finish(request);
    const next = await runner.prepare({nonce:request.nonce});
    work = join(root,'runs',next.run,'work');
    await writeFile(join(work,'package-lock.json'),'lock');
    request = {...request,...next,inputDigest:await digestInput(work)};
    expect((await runner.run(request)).code).toBe(3);
    const installs = (await readFile(join(root,'install.log'),'utf8')).trim().split('\n');
    expect(first.error).toMatch(/shrinkwrap/i);
    expect(installsBefore).toBe('');
    expect(installs).toHaveLength(1);
    expect(installs[0]).not.toContain('--dry-run');
  });
  it.each(['dev-v3','dev-v4'])('does not reuse archives from the old package-lock-only cache profile %s', async version => {
    const old = join(root,'cache',request.lock,version);
    await mkdir(old,{recursive:true});
    await writeFile(join(old,'dependencies.tar'),'historically poisoned');
    await writeFile(join(old,'sha256'),hash('historically poisoned'));
    expect((await runner.run(request)).code).toBe(3);
    expect(await readFile(join(root,'install.log'),'utf8')).not.toContain('--dry-run');
    expect(await readFile(join(old,'dependencies.tar'),'utf8')).toBe('historically poisoned');
  });
  it('preserves split UTF-8 in captured worker output', async () => {
    await writeFile(join(root,'bin','npm'), `#!${process.execPath}
if (process.argv[2] !== 'ci') {
  const bytes = Buffer.from('é😀');
  process.stdout.write(bytes.subarray(0,1));
  process.stderr.write(bytes.subarray(0,3));
  setTimeout(() => { process.stdout.write(bytes.subarray(1)); process.stderr.write(bytes.subarray(3)); }, 100);
}
`,{mode:0o755});
    expect(await runner.run(request)).toMatchObject({code:0,stdout:'é😀',stderr:'é😀'});
  });
  it('refuses an overlapping run and rechecks its input after the first worker substitutes its assertions', async () => {
    const other = createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin'});
    const prepared = await other.prepare({nonce:'c'.repeat(32)});
    const victim = join(root,'runs',prepared.run,'work');
    await writeFile(join(victim,'package-lock.json'),'different lock');
    await writeFile(join(victim,'assertions.cjs'),'process.exit(1)');
    const second = {...request,...prepared,nonce:'c'.repeat(32),lock:hash('different lock'),inputDigest:await digestInput(victim)};
    await writeFile(join(root,'bin','npm'), `#!/bin/bash
if [ "$1" = ci ]; then exit 0; fi
exec node '${join(root,'task.cjs')}'
`, {mode:0o755});
    await writeFile(join(root,'task.cjs'), `
const fs = require('node:fs');
if (process.cwd() === ${JSON.stringify(victim)}) require(${JSON.stringify(join(victim,'assertions.cjs'))});
else {
  fs.writeFileSync(${JSON.stringify(join(root,'ready'))}, '');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(join(root,'release'))})) return;
    clearInterval(timer);
    fs.writeFileSync(${JSON.stringify(join(victim,'assertions.cjs'))}, 'process.exit(0)');
  }, 10);
  setTimeout(() => process.exit(2), 5000).unref();
}
`);
    const first = runner.run(request);
    try {
      await vi.waitFor(async () => expect((await stat(join(root,'ready'))).isFile()).toBe(true));
      await expect(other.run(second)).rejects.toThrow('Worker execution busy');
    } finally {
      await writeFile(join(root,'release'),'');
      await first;
    }
    expect(await readFile(join(victim,'assertions.cjs'),'utf8')).toBe('process.exit(0)');
    await expect(other.run(second)).rejects.toThrow('Input digest mismatch');
    expect(await other.finish(second)).toBeNull();
    expect(await runner.finish(request)).toMatchObject({phase:'test',code:0});
  }, 15000);
  it('keeps an abandoned execution guard closed even after finish and pruning age', async () => {
    const active = join(root,'receipts','worker-active');
    await mkdir(active,{mode:0o700});
    const expired = new Date(Date.now()-30*24*60*60*1000);
    await utimes(active,expired,expired);
    await expect(runner.run(request)).rejects.toThrow('Worker execution busy');
    expect(await runner.finish(request)).toBeNull();
    expect((await stat(active)).isDirectory()).toBe(true);
  });
  it('retains the execution guard when a worker command rejects instead of confirming shutdown', async () => {
    await writeFile(join(root,'bin','npm'),`#!${process.execPath}
process.stdout.write('x'.repeat(4*1024*1024+1));
`,{mode:0o755});
    expect(await runner.run(request)).toMatchObject({code:97,stderr:'Output limit exceeded'});
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
    expect((await stat(join(root,'receipts','worker-active'))).isDirectory()).toBe(true);
    const next = await runner.prepare({nonce:request.nonce});
    await expect(runner.run({...request,...next})).rejects.toThrow('Worker execution busy');
  });
  it('rejects Git-dependent standards requests at the server boundary', async () => {
    const command = ['npm','run','check:standards'];
    await expect(runner.run({...request,argv:command,argvDigest:digestArgv(command)})).rejects.toThrow('Invalid execution parameters');
    await expect(stat(join(root,'install.log'))).rejects.toThrow();
  });
  it.each([
    ['npm','--ignore-scripts','run','test:unit'], ['npm','run','test:unit','--help'],
    ['npm','run','test:unit','extra'], ['npm','run','build'], ['sh','-c','true'],
    ['npm','run','check:standards','--workspace=other'],
  ])('rejects bypass argv %j', async (...bad) => {
    await expect(runner.run({...request,argv:bad,argvDigest:digestArgv(bad)})).rejects.toThrow();
  });
  it.each(['NODE_OPTIONS','PATH','HOME','npm_config_script_shell','GITHUB_TOKEN','ci'])('rejects env poisoning %s', async key => {
    await expect(runner.run({...request,env:{[key]:'poison'}})).rejects.toThrow();
  });
  it('isolates install environment, preserves literal argv, nulls task stdin, and ignores forged receipts', async () => {
    const result = await runner.run(request);
    expect(result.code).toBe(3);
    expect(await readFile(join(work,'stdin-seen'),'utf8')).toBe('');
    expect(JSON.parse(await readFile(join(work,'argv-seen'),'utf8'))).toEqual(argv.slice(1));
    expect(await readFile(join(work,'task-seen'),'utf8')).toContain("two words a'b $(touch marker) line\nbreak|production");
    await expect(stat(join(work,'marker'))).rejects.toThrow();
    const log = await readFile(join(root,'install.log'),'utf8');
    expect(log).toContain('--include=dev --ignore-scripts --no-audit --no-fund');
    expect(log).not.toContain('production');
    expect(log).not.toContain(process.env.HOME);
    expect(await runner.finish(request)).toEqual({v:1,nonce:request.nonce,run:request.run,inputDigest:request.inputDigest,
      argvDigest:request.argvDigest,lock:request.lock,phase:'test',code:3});
    await expect(stat(join(root,'runs',request.run))).rejects.toThrow();
    await expect(runner.finish(request)).rejects.toThrow();
    expect(await readdir(join(root,'receipts'))).toEqual([request.run+'.consumed']);
  });
  it('rejects input and lock changes before install and accepts odd filenames literally', async () => {
    for (const name of ['#file',';file',"quote'`$()",'--option','é\u2028fixture','tab\tfile','trailing ']) await writeFile(join(work,name),name);
    await expect(runner.run(request)).rejects.toThrow(/digest/);
    request.inputDigest = await digestInput(work);
    expect((await runner.run(request)).code).toBe(3);
  });
  it('records install failure even when a task receipt is planted', async () => {
    await writeFile(join(work,'fail-install'),'');
    await writeFile(join(work,'receipt.json'),JSON.stringify({phase:'test',code:97}));
    request.inputDigest = await digestInput(work);
    expect((await runner.run(request)).code).toBe(97);
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
    await expect(stat(join(work,'task-seen'))).rejects.toThrow();
  });
  it('does not reuse labels, rejects invalid run names, and consumes prepared state once', async () => {
    const other = await runner.prepare({nonce:request.nonce,label:'abcdef-1'});
    expect(other.run).not.toBe(request.run);
    await expect(runner.run({...request,run:'abcdef-1'})).rejects.toThrow();
    await runner.run(request);
    await expect(runner.run(request)).rejects.toThrow();
  });
  it('refuses to adopt a planted valid-format run directory without protected prepared state', async () => {
    const planted = 'r-'+'c'.repeat(32);
    expect(planted).toMatch(/^r-[a-f0-9]{32}$/);
    const plantedWork = join(root,'runs',planted,'work');
    await mkdir(plantedWork,{recursive:true});
    await writeFile(join(plantedWork,'package-lock.json'),'lock');
    expect(await digestInput(plantedWork)).toBe(request.inputDigest);
    const receiptsBefore = await readdir(join(root,'receipts'));
    await expect(runner.run({...request,run:planted})).rejects.toMatchObject({
      code:'ENOENT',path:join(root,'receipts',planted+'.prepared'),
    });
    expect(await readdir(plantedWork)).toEqual(['package-lock.json']);
    expect(await readFile(join(plantedWork,'package-lock.json'),'utf8')).toBe('lock');
    expect(await readdir(join(root,'receipts'))).toEqual(receiptsBefore);
    await expect(stat(join(root,'install.log'))).rejects.toThrow();
  });
  it('rejects tampered archives before extraction and reuses complete nested dependency snapshots', async () => {
    await runner.run(request);
    await runner.finish(request);
    const next = await runner.prepare({nonce:request.nonce,label:'abcdef-1'});
    work = join(root,'runs',next.run,'work');
    await writeFile(join(work,'package-lock.json'),'lock');
    request = {...request,run:next.run,inputDigest:await digestInput(work)};
    expect((await runner.run(request)).code).toBe(3);
    expect((await readFile(join(root,'install.log'),'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
    await runner.finish(request);
    const third = await runner.prepare({nonce:request.nonce});
    work = join(root,'runs',third.run,'work');
    await writeFile(join(work,'package-lock.json'),'lock');
    request = {...request,run:third.run,inputDigest:await digestInput(work)};
    await writeFile(join(root,'cache',request.lock,'dev-v5-'+request.inputDigest,'dependencies.tar'),'tampered');
    expect((await runner.run(request)).code).toBe(97);
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
  });
  it('quarantines execution after wrapper death until an operator stops the worker and clears the guard', async () => {
    const npm = join(root,'bin','npm');
    const original = await readFile(npm,'utf8');
    await writeFile(npm,`#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(join(root,'install-pid'))},String(process.pid));
process.kill(process.ppid,'SIGUSR2');
process.kill(process.pid,'SIGSTOP');
`,{mode:0o755});
    const source = `import {createRunner} from ${JSON.stringify(new URL('../forge-exec-run.mjs',import.meta.url).href)};
process.on('SIGUSR2',()=>{process.send('install');process.kill(process.pid,'SIGSTOP');});
const runner=createRunner({testRoot:process.argv[1],testPath:process.argv[2]});
await runner.run(JSON.parse(process.argv[3]));`;
    const holder = spawn(process.execPath,['--input-type=module','-e',source,root,join(root,'bin')+':/usr/bin:/bin',JSON.stringify(request)],{
      stdio:['ignore','ignore','ignore','ipc'],
    });
    const exited = once(holder,'exit');
    const nextRequest = async () => {
      const prepared = await runner.prepare({nonce:request.nonce});
      const nextWork = join(root,'runs',prepared.run,'work');
      await writeFile(join(nextWork,'package-lock.json'),'lock');
      return {...request,run:prepared.run,inputDigest:await digestInput(nextWork)};
    };
    try {
      const [message] = await once(holder,'message',{signal:AbortSignal.timeout(10000)});
      expect(message).toBe('install');
      const blocked = await nextRequest();
      await expect(runner.run(blocked)).rejects.toThrow('Worker execution busy');
      expect(await runner.finish(blocked)).toBeNull();
      holder.kill('SIGKILL');
      expect(await exited).toEqual([null,'SIGKILL']);
      const interrupted = await nextRequest();
      await expect(runner.run(interrupted)).rejects.toThrow('Worker execution busy');
      expect(await runner.finish(interrupted)).toBeNull();
      // Simulate explicit operator recovery only after the orphan is killed.
      const pid = Number(await readFile(join(root,'install-pid'),'utf8'));
      process.kill(-pid,'SIGKILL');
      await rm(join(root,'receipts','worker-active'),{recursive:true});
      await writeFile(npm,original,{mode:0o755});
      // Persisted sentinels from older wrappers must not block recovery either.
      await mkdir(join(root,'cache',request.lock,'dev-v5-'+request.inputDigest,'.busy'));
      const recovered = await nextRequest();
      expect((await runner.run(recovered)).code).toBe(3);
      expect(await runner.finish(recovered)).toMatchObject({phase:'test',code:3});
    } finally {
      holder.kill('SIGKILL');
      await exited;
      const pid = Number(await readFile(join(root,'install-pid'),'utf8').catch(()=>0));
      if(pid) try {process.kill(-pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}
    }
  }, 15000);
  it('rejects symlinked cache lock files without changing their targets', async () => {
    const profile = join(root,'cache',request.lock,'dev-v5-'+request.inputDigest);
    await mkdir(profile,{recursive:true});
    const target = join(root,'lock-target');
    await writeFile(target,'untouched');
    await symlink(target,join(profile,'.lock'));
    expect((await runner.run(request)).code).toBe(97);
    expect(await runner.finish(request)).toMatchObject({phase:'install',code:97});
    expect(await readFile(target,'utf8')).toBe('untouched');
    await expect(stat(join(root,'install.log'))).rejects.toThrow();
  });
  it('rejects symlinks at the work boundary and in the input snapshot', async () => {
    await symlink(root,join(work,'escape'));
    await expect(digestInput(work)).rejects.toThrow();
    await rm(join(work,'escape'));
    await rm(work,{recursive:true});
    await symlink(root,work);
    await expect(runner.run(request)).rejects.toThrow();
  });
  it('uses a subreaper and kills adopted setsid descendants before returning a receipt', () => {
    // Darwin cannot exercise Linux prctl; assert the production supervisor protocol here.
    expect(supervisorSource).toContain('PR_SET_CHILD_SUBREAPER');
    expect(supervisorSource).toContain('os.setsid');
    expect(supervisorSource).toContain('os.kill(pid, signal.SIGKILL)');
    expect(supervisorSource).toContain('os.waitpid(-1');
    expect(supervisorSource).toContain('stdin=subprocess.DEVNULL');
  });
  it('completes supervisor cleanup with arbitrary bytes and delimiters in proc process names', async () => {
    const status=join(root,'byte-name-status');
    // Execute the shipped supervisor on every platform; only OS/process effects
    // are mocked. Real file decoding reproduces the Linux stat failure on macOS.
    const probe=String.raw`import builtins, ctypes, json, os, signal, subprocess, sys
from unittest.mock import patch
source, root, status = sys.argv[1:]
entries = {
    '101': b'101 (\xff) S 100 0 0\n',
    '102': b'102 (a) \n\r\t\xfe)) S 101 0 0\n',
    '103': b'103 (\xe2\x80\xa8\xe2\x80\x8b) S 102 0 0\n',
    '104': b'104 (--\x60\x27../) S 999 0 0\n',
}
for pid, data in entries.items():
    with open(os.path.join(root, pid), 'wb') as f: f.write(data)
real_open = builtins.open
def proc_open(path, *args, **kwargs):
    return real_open(os.path.join(root, path.split('/')[2]), *args, **kwargs)
killed = []
def kill(pid, sig):
    assert sig == signal.SIGKILL
    killed.append(pid)
def reap(*args):
    assert set(killed) == {101, 102, 103}, killed
    raise ChildProcessError()
cfg = dict(uid=os.getuid(), gid=os.getgid(), argv=['unused'], cwd=root, env={}, status=status)
with patch.object(ctypes, 'CDLL') as libc, patch.object(subprocess, 'Popen') as worker, \
     patch.object(os, 'listdir', return_value=[*entries, 'self', '105']), \
     patch.object(os, 'getpid', return_value=100), patch.object(builtins, 'open', side_effect=proc_open), \
     patch.object(os, 'kill', side_effect=kill), patch.object(os, 'waitpid', side_effect=reap):
    libc.return_value.prctl.return_value = 0
    worker.return_value.wait.return_value = 3
    sys.argv = ['supervisor', json.dumps(cfg)]
    exec(source)
`;
    const result=spawnSync('python3',['-I','-c',probe,supervisorSource,root,status],{encoding:'utf8',timeout:10000});
    expect(result.status,result.stderr).toBe(0);
    expect(await readFile(status,'utf8')).toBe('3');
  });
});

describe('setup and pruning contract', () => {
  it('installs a root-owned fixed wrapper, makes the old cache inert, and prunes only expired state', async () => {
    const setup=await readFile(new URL('../forge-setup.sh',import.meta.url),'utf8');
    expect(setup).toContain('os.fchown(fd, 0, 0)');
    expect(setup).toContain('os.fchmod(fd, 0o755)');
    expect(setup).toContain('os.fchmod(cache, 0o700)');
    expect(setup).toContain('("forge-receipts", ops.pw_uid, ops.pw_gid, 0o700)');
    expect(setup).toContain('("forge-cache", 0, ops.pw_gid, 0o770)');
    const prune=setup.match(/<<'PRUNE'\n([\s\S]*?)\nPRUNE/)[1];
    expect(prune).toContain('-mmin +1440');
    expect(prune).toContain('-mmin +20160');
    const expired=new Date(Date.now()-16*24*60*60*1000);
    const oldRun=join(root,'runs','r-expired'), oldReceipt=join(root,'receipts','expired.receipt');
    const oldCache=join(root,'cache','expired'), newCache=join(root,'cache','fresh');
    const active=join(root,'receipts','worker-active');
    await mkdir(active,{mode:0o700});
    await mkdir(oldRun); await writeFile(oldReceipt,'old'); await mkdir(oldCache); await mkdir(newCache);
    for(const path of [oldRun,oldReceipt,oldCache,active]) await utimes(path,expired,expired);
    const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
    const local=prune.replaceAll('/srv/forge-exec',quote(join(root,'runs')))
      .replaceAll('/srv/forge-receipts',quote(join(root,'receipts')))
      .replaceAll('/srv/forge-cache',quote(join(root,'cache')));
    const result=spawnSync('bash',['-c',local],{encoding:'utf8'});
    expect(result.status,result.stderr).toBe(0);
    for(const path of [oldRun,oldReceipt,oldCache]) await expect(stat(path)).rejects.toThrow();
    expect((await stat(newCache)).isDirectory()).toBe(true);
    expect((await stat(work)).isDirectory()).toBe(true);
    expect((await stat(active)).isDirectory()).toBe(true);
  });
  it('the production CLI rejects extra argv and oversized requests without accepting test-root environment overrides', () => {
    const source=new URL('../forge-exec-run.mjs',import.meta.url);
    for(const args of [['prepare','extra'],['prepare']]) {
      const result=spawnSync(process.execPath,[source.pathname,...args],{
        input:args.length===1?'x'.repeat(4*1024*1024+1):'{}',encoding:'utf8',maxBuffer:1024*1024,
        env:{PATH:process.env.PATH,FORGE_EXEC_TEST_ROOT:root},
      });
      expect(result.status).toBe(254);
      expect(result.stderr).toContain(args.length===1?'Request limit exceeded':'Invalid subcommand');
    }
  });
});

it.skipIf(process.platform !== 'linux')('kills a real escaped setsid child with a non-UTF-8 process name through Linux subreaper adoption', async () => {
  const marker=join(root,'escaped-pid');
  const status=join(root,'supervised-status');
  const task=String.raw`import ctypes, os, sys, time
pid=os.fork()
if pid:
    while not os.path.exists(sys.argv[1]): time.sleep(0.01)
    sys.exit(3)
os.setsid()
assert ctypes.CDLL(None).prctl(15, ctypes.c_char_p(b'\xff)\n\xfe)'), 0, 0, 0) == 0
with open(sys.argv[1], 'w') as f: f.write(str(os.getpid()))
time.sleep(30)
`;
  const result=spawnSync('python3',['-I','-c',supervisorSource,JSON.stringify({
    argv:['python3','-I','-c',task,marker],cwd:root,env:{PATH:process.env.PATH},
    uid:process.getuid(),gid:process.getgid(),status,
  })],{encoding:'utf8',timeout:10000});
  const pid=Number(await readFile(marker,'utf8').catch(()=>0));
  try {
    expect(result.status,result.stderr).toBe(0);
    expect(await readFile(status,'utf8')).toBe('3');
    expect(pid).toBeGreaterThan(0);
    expect(()=>process.kill(pid,0)).toThrow();
  } finally {
    if(pid) try {process.kill(pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH') throw error;}
  }
});

describe('privileged finish cleanup', () => {
  it('delegates removal of a validated nonempty worker tree before consuming state', async () => {
    const cleanup=vi.fn(async ({file,args}) => {
      expect(file).toBe('/usr/bin/sudo');
      expect(args).toEqual(['-n','/usr/bin/rm','-rf','--',join(root,'runs',request.run)]);
      expect(await readFile(join(work,'task-seen'),'utf8')).toContain('production');
      expect(await readFile(join(root,'receipts',request.run+'.running'),'utf8')).toContain(request.nonce);
      await rm(args.at(-1),{recursive:true,force:true});
      return {code:0};
    });
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    expect((await isolated.run(request)).code).toBe(3);
    expect(await isolated.finish(request)).toMatchObject({phase:'test',code:3});
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(stat(join(root,'runs',request.run))).rejects.toThrow();
    expect(await readdir(join(root,'receipts'))).toEqual([request.run+'.consumed']);
  });
  it('refuses cleanup failure without consuming state or publishing success', async () => {
    const cleanup=vi.fn(async ()=>({code:1}));
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    await isolated.run(request);
    await expect(isolated.finish(request)).rejects.toThrow('Run cleanup failed');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect((await stat(work)).isDirectory()).toBe(true);
    expect(await readdir(join(root,'receipts'))).toEqual([request.run+'.receipt',request.run+'.running']);
  });
  it('refuses claimed cleanup success when the run directory remains', async () => {
    const cleanup=vi.fn(async ()=>({code:0}));
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    await expect(isolated.finish(request)).rejects.toThrow('Run cleanup incomplete');
    expect(await readdir(join(root,'receipts'))).toEqual([request.run+'.prepared']);
    expect((await stat(work)).isDirectory()).toBe(true);
  });
  it('does not delegate invalid or symlink-swapped run containers', async () => {
    const cleanup=vi.fn(async ()=>({code:0}));
    const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
    await expect(isolated.finish({...request,run:'../outside'})).rejects.toThrow();
    await rm(join(root,'runs',request.run),{recursive:true});
    await symlink(join(root,'bin'),join(root,'runs',request.run));
    await expect(isolated.finish(request)).rejects.toThrow();
    expect(cleanup).not.toHaveBeenCalled();
    expect((await stat(join(root,'bin','npm'))).isFile()).toBe(true);
  });
});

// Required on Linux: execute this suite as a non-root ops test user with
// passwordless sudo for python3 and rm. It uses numeric worker IDs, no accounts
// are created and every mutation is confined to this test's TMPDIR fixture.
it.skipIf(process.platform !== 'linux')('cross-identity cleanup finishes a nonempty 0755 worker-owned run after prepare and execution', async () => {
  expect(process.getuid(),'Linux cross-identity fixture requires a non-root ops user with passwordless sudo').not.toBe(0);
  const workerUid=65534, workerGid=65534;
  const task=String.raw`import os
os.chown('.', 65534, 65534)
os.setgroups([])
os.setgid(65534)
os.setuid(65534)
os.mkdir('worker-data', 0o755)
with open('worker-data/result', 'w') as f: f.write('worker-owned')
os.chmod('.', 0o755)
`;
  const quote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
  await writeFile(join(root,'bin','npm'),`#!/bin/bash
if [ "$1" = ci ]; then mkdir -p node_modules; exit 0; fi
exec /usr/bin/sudo -n /usr/bin/python3 -I -c ${quote(task)}
`,{mode:0o755});
  const cleanup=vi.fn(async ({file,args}) => {
    const result=spawnSync(file,args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    if(result.error) throw result.error;
    return {code:result.status,stdout:result.stdout,stderr:result.stderr};
  });
  const isolated=createRunner({testRoot:root,testPath:join(root,'bin')+':/usr/bin:/bin',testCleanupExec:cleanup});
  expect((await isolated.run(request)).code).toBe(0);
  expect(await stat(work)).toMatchObject({uid:workerUid,gid:workerGid});
  expect((await stat(work)).mode & 0o777).toBe(0o755);
  expect(await stat(join(work,'worker-data','result'))).toMatchObject({uid:workerUid});
  expect(await readFile(join(work,'worker-data','result'),'utf8')).toBe('worker-owned');
  await expect(rm(join(work,'worker-data','result'))).rejects.toMatchObject({code:'EACCES'});
  expect(await isolated.finish(request)).toMatchObject({phase:'test',code:0});
  expect(cleanup).toHaveBeenCalledTimes(1);
  await expect(stat(join(root,'runs',request.run))).rejects.toThrow();
  expect(await readdir(join(root,'receipts'))).toEqual([request.run+'.consumed']);
});
