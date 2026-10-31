// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import * as runner from '../forge-exec-run.mjs';
import {isAllowedCommand, verifyReceipt, runRemote} from '../remote-exec.mjs';
import {resolveAdmissionPolicy, formatAdmissionPolicy, runWithRemoteDecision, heldSlots} from '../heavy-admission.mjs';
import {main as telemetryCli, readForgeTelemetry} from '../forge-telemetry.mjs';
import {checkRemoteHealth} from '../forge-remote-health.mjs';
import {keepAliveScript} from '../../lib/test-keepalive.mjs';

const roots = [];
const scratch = () => {const root=mkdtempSync(join(process.env.TMPDIR,'forge-controls-')); roots.push(root); return root;};
afterEach(() => {vi.useRealTimers(); for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const now = Date.parse('2026-10-29T21:40:00-04:00');
const sample = (ms=now) => ({sampledAtET:runner.easternTimestamp(ms),cores:8,loadPerCore:0.12,memFreePct:96,activeRuns:3,
  recent:[{runId:'r-'+'a'.repeat(32),startedAtET:runner.easternTimestamp(ms-41000),stageMs:{install:1000,run:40000},code:0}]});
const policy = remote => resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',...remote}}});
const command = ['npx','vitest','run','a.test.mjs'];
const classes = [command,['npx','vitest','related','src/a.ts','--run'],['npm','run','test:integration:vitest'],['npm','run','test:coverage']];
const withArg = (argv,arg) => argv[0]==='npm' ? [...argv,'--',arg] : [...argv,arg];

describe('Forge synchronous module loading', () => {
  it.each(['forge-exec-run.mjs','forge-telemetry.mjs','remote-exec.mjs','forge-warm-base.mjs','forge-exec-limits.mjs'])
  ('loads %s synchronously without executing its CLI', module => {
    // Native require rejects any top-level await in the entire static import graph.
    const result=spawnSync(process.execPath,['--experimental-require-module','-e',
      'require(process.env.FORGE_MODULE);'],{
      env:{...process.env,FORGE_MODULE:fileURLToPath(new URL('../'+module,import.meta.url))},
      encoding:'utf8',timeout:10000,maxBuffer:1024*1024,
    });
    expect(result.status,result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('Forge telemetry contracts', () => {
  it('samples on demand on a fresh install without a telemetry file', async () => {
    const root=scratch(),server=runner.createRunner({testRoot:root,clock:()=>now});
    expect(await server.telemetry()).toMatchObject({sampledAtET:runner.easternTimestamp(now),activeRuns:0,recent:[]});
    expect(runner.parseTelemetry(readFileSync(join(root,'receipts','telemetry.json'),'utf8')).sampledAtET)
      .toBe(runner.easternTimestamp(now));
  });
  it('refreshes stale idle Forge telemetry over SSH, caches for ten seconds and retries failed SSH after backoff', async () => {
    let time=now;
    const root=scratch(),healthRoot=scratch(),receipts=join(root,'receipts');mkdirSync(receipts,{mode:0o700});
    writeFileSync(join(receipts,'telemetry.json'),JSON.stringify(sample(now-60000)));
    const server=runner.createRunner({testRoot:root,clock:()=>time});
    const exec=vi.fn((_file,args,_options,done)=>{
      expect(args.at(-1)).toBe('sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs telemetry');
      server.telemetry().then(value=>done(null,JSON.stringify(value)),done);
    });
    const settings={maxLoadPerCore:Number.MAX_VALUE,minFreeRamPct:0,backoffMs:120000};
    const check=()=>checkRemoteHealth({root:healthRoot,settings,clock:()=>time,
      readTelemetry:options=>readForgeTelemetry({...options,exec})});
    expect(await check()).toEqual({ok:true});
    time+=9999;expect(await check()).toEqual({ok:true});
    expect(exec).toHaveBeenCalledTimes(1);
    time++;expect(await check()).toEqual({ok:true});
    expect(exec).toHaveBeenCalledTimes(2);
    time+=60000;expect(await check()).toEqual({ok:true});
    expect(exec).toHaveBeenCalledTimes(3);
    exec.mockImplementationOnce((_f,_a,_o,done)=>done(new Error('offline')));
    time+=10000;expect(await check()).toEqual({ok:false,reason:'forge-unreachable'});
    time+=119999;expect(await check()).toEqual({ok:false,reason:'backoff-forge-unreachable'});
    expect(exec).toHaveBeenCalledTimes(4);
    time++;expect(await check()).toEqual({ok:true});
    expect(exec).toHaveBeenCalledTimes(5);
  });
  it('fails closed when live sampling finds unreadable run evidence', async () => {
    const root=scratch(),receipts=join(root,'receipts');mkdirSync(receipts,{mode:0o700});
    writeFileSync(join(receipts,'r-'+'a'.repeat(32)+'.telemetry'),'{}');
    await expect(runner.createRunner({testRoot:root}).telemetry()).rejects.toThrow();
  });
  it('strictly parses and formats bounded Eastern telemetry', () => {
    const value=sample();
    expect(runner.parseTelemetry(JSON.stringify(value))).toEqual(value);
    expect(runner.formatTelemetry(value,'forge')).toBe('forge 21:40 ET load/core 0.12 ram free 96% runs 3 last-run 41s');
  });
  it.each([
    {cores:0},{cores:1.5},{loadPerCore:-1},{loadPerCore:null},{memFreePct:101},{activeRuns:-1},
    {sampledAtET:'2026-10-29T21:40:00Z'},{sampledAtET:'2026-02-30T21:40:00-05:00'},
    {recent:Array(51).fill({})},{extra:'secret'}, {recent:[{runId:'bad'}]},
  ])('rejects incomplete or invalid telemetry %j', patch => {
    expect(()=>runner.parseTelemetry(JSON.stringify({...sample(),...patch}))).toThrow();
  });
  it('rejects oversized telemetry and missing fields', () => {
    expect(()=>runner.parseTelemetry(' '.repeat(65537))).toThrow();
    expect(()=>runner.parseTelemetry('{}')).toThrow();
  });
  it('uses exactly one bounded SSH read, prints JSON or one line, and rejects unsafe hosts', async () => {
    const exec=vi.fn((file,args,options,done)=>done(null,JSON.stringify(sample())));
    expect(await readForgeTelemetry({exec})).toEqual(sample());
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0].slice(0,3)).toEqual(['ssh',expect.arrayContaining(['forge',
      'sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs telemetry']),expect.objectContaining({maxBuffer:65536,timeout:8000})]);
    const read=vi.fn(async()=>sample()),write=vi.fn();
    await telemetryCli(['--json'],{read,write});
    expect(write).toHaveBeenLastCalledWith(JSON.stringify(sample())+'\n');
    await telemetryCli(['--host=forge'],{read,write});
    expect(write).toHaveBeenLastCalledWith(runner.formatTelemetry(sample())+'\n');
    await expect(readForgeTelemetry({host:'-oProxyCommand=bad',exec})).rejects.toThrow();
    await expect(telemetryCli(['--host=forge;bad'],{read,write})).rejects.toThrow();
    await expect(readForgeTelemetry({exec:(_f,_a,_o,done)=>done(null,'{}')})).rejects.toThrow();
    await expect(readForgeTelemetry({exec:(_f,_a,_o,done)=>done(new Error('private'))})).rejects.toThrow('forge-unreachable');
  });
  it('publishes prepare and finish atomically without nonces, labels or environment', async () => {
    const root=scratch(),server=runner.createRunner({testRoot:root,clock:()=>now});
    const prepared=await server.prepare({nonce:'b'.repeat(32),label:'secret-label'});
    expect(prepared.capabilities.commandClasses).toBe(1);
    const first=await server.telemetry();
    expect(first).toMatchObject({sampledAtET:runner.easternTimestamp(now),activeRuns:1});
    expect(JSON.stringify(first)).not.toContain('secret');
    expect(JSON.stringify(first)).not.toContain('b'.repeat(32));
    await server.finish({run:prepared.run,nonce:'b'.repeat(32)});
    expect((await server.telemetry()).activeRuns).toBe(0);
    expect(runner.parseTelemetry(readFileSync(join(root,'receipts','telemetry.json'),'utf8'))).toMatchObject({activeRuns:0});
  });
  it('publishes only the most recent 50 runs in descending start order', async () => {
    let time=now-120000;
    const root=scratch(),server=runner.createRunner({testRoot:root,clock:()=>time});
    const first=await server.prepare({nonce:'b'.repeat(32)});
    time=now;
    for(let i=0;i<60;i++) {
      const record={...sample(now-i*1000).recent[0],runId:'r-'+i.toString(16).padStart(32,'0')};
      writeFileSync(join(root,'receipts',record.runId+'.telemetry'),JSON.stringify(record));
    }
    await server.finish({run:first.run,nonce:'b'.repeat(32)});
    const value=await server.telemetry();
    expect(value.recent).toHaveLength(50);
    expect(value.recent[0].runId).toBe('r-'+'0'.repeat(32));
    expect(value.recent.at(-1).runId).toBe('r-'+(49).toString(16).padStart(32,'0'));
  });
});

describe('shared command classes', () => {
  it('proves the installed Vitest parser disables related run mode for --run false, and refuses it on both boundaries',()=>{
    // Keep the runner's native ESM dependency graph outside the Vitest worker.
    // The child still exercises the installed public parser, without starting a suite.
    const parsed = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import {parseCLI} from 'vitest/node';
      console.log(JSON.stringify(parseCLI(['vitest','related','src/a.ts','--run','false']).options.run));
    `], {cwd:new URL('../../../', import.meta.url), encoding:'utf8', timeout:10000, maxBuffer:65536});
    expect(parsed.status, parsed.error?.message || parsed.stderr).toBe(0);
    expect(JSON.parse(parsed.stdout)).toBe(false);
    for(const value of ['false','False','FALSE','false.test.mjs']){
      const argv=['npx','vitest','related','src/a.ts','--run',value];
      expect(isAllowedCommand(argv)).toBe(false);
      expect(runner.allowedCommand(argv)).toBe(false);
    }
  }, 15000);
  it.each(['--run','--silent','--no-color'].flatMap(flag=>
    ['false','true','false.test.mjs','true-source.ts'].map(value=>[flag,value])))
  ('rejects boolean-looking positional values immediately after %s: %s', (flag,value) => {
    for(const base of [...classes,['npm','run','test:unit']]) {
      const argv=base[0]==='npm'?[...base,'--',flag,value]:[...base,flag,value];
      expect(isAllowedCommand(argv)).toBe(false);
      expect(runner.allowedCommand(argv)).toBe(false);
      expect(()=>runner.executionArgv(argv)).toThrow('Invalid execution parameters');
    }
  });
  it.each(['--run=false','--run=0'])('rejects mode-changing assignment %s', arg => {
    const argv=['npx','vitest','related','src/a.ts','--run',arg];
    expect(isAllowedCommand(argv)).toBe(false);
    expect(()=>runner.executionArgv(argv)).toThrow('Invalid execution parameters');
  });
  it('allows ordinary filenames after boolean flags and boolean text in test patterns', () => {
    expect(runner.allowedCommand(['npx','vitest','related','--run','src/false.ts','--silent','a.test.mjs','-t','false']))
      .toBe(true);
  });
  it.each(classes.map(argv=>[argv]))('allows and constructs a fixed argv for %j', argv => {
    expect(isAllowedCommand(argv)).toBe(true);
    expect(runner.allowedCommand(argv)).toBe(true);
    const fixed=runner.executionArgv(argv);
    expect(fixed.slice(0,2)).toEqual(['node','node_modules/vitest/vitest.mjs']);
    if(argv[2]==='test:coverage')expect(fixed).toContain('--coverage');
    if(argv[2]==='test:integration:vitest')expect(fixed.slice(-2)).toEqual(['--config','vitest.integration.config.ts']);
  });
  const rejected=['--config','--config=','--config=x','--root','--root=x','--dir','--dir=x','--outputFile','--outputFile=x',
    '--coverage.reportsDirectory','--coverage.reportsDirectory=x','--coverage.reporter=html','--coverage.thresholds.lines=0',
    '--setupFiles=x','--reporter=./evil.mjs','--poolOptions.threads.execArgv=--import=x','--passWithNoTests','--run=false',
    '--Run','--coverage=false','--watch','--inspect','--','../a.test.mjs','x/../a.test.mjs','/a.test.mjs','C:\\a.test.mjs','x\\..\\a.test.mjs'];
  it.each(classes.flatMap(argv=>rejected.map(arg=>[argv,arg])))('rejects unsafe spelling %j %s on both sides', (argv,arg) => {
    expect(isAllowedCommand(withArg(argv,arg))).toBe(false);
    expect(runner.allowedCommand(withArg(argv,arg))).toBe(false);
  });
  it('requires related --run and positional files, rejects normalization collisions', () => {
    for(const argv of [['npx','vitest','related','a.ts'],['npx','vitest','run'],['npx','vitest','related','--run'],
      ['npx','vitest','run','A.test.mjs','a.test.mjs']])expect(runner.allowedCommand(argv)).toBe(false);
  });
  it.each(classes.map(argv=>[argv]))('binds receipt digest to the requested command class %j', argv => {
    const expected={v:1,nonce:'b'.repeat(32),run:'r-'+'a'.repeat(32),inputDigest:'c'.repeat(64),lock:'d'.repeat(64),
      manifestDigest:'e'.repeat(64),argvDigest:runner.digestArgv(argv)};
    const receipt={...expected,phase:'test',code:0};
    expect(verifyReceipt(JSON.stringify(receipt),expected,0)).toBe(true);
    expect(verifyReceipt(JSON.stringify({...receipt,argvDigest:runner.digestArgv([...argv,'--silent'])}),expected,0)).toBe(false);
  });
  async function runningFixture(argv,{gate=false}={}) {
    const root=scratch(),bin=join(root,'bin');mkdirSync(bin);
    symlinkSync(process.execPath,join(bin,'node'));
    const task="require('node:fs').writeFileSync('argv.json',JSON.stringify(process.argv.slice(2)));process.exit(5)";
    writeFileSync(join(bin,'npm'),`#!${process.execPath}\nconst fs=require('node:fs');
if(process.argv[2]!=='ci')process.exit(91);
fs.mkdirSync('node_modules/vitest',{recursive:true});fs.writeFileSync('node_modules/vitest/vitest.mjs',${JSON.stringify("import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"+task)});
${gate?`if(!fs.existsSync(${JSON.stringify(join(root,'release'))})){const watch=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(${JSON.stringify(join(root,'release'))})){watch.close();process.exit(0);}});}`:''}
`,{mode:0o755});
    let time=now;
    const server=runner.createRunner({testRoot:root,testPath:bin+':/usr/bin:/bin',clock:()=>time});
    const prepared=await server.prepare({nonce:'b'.repeat(32)}),work=join(root,'runs',prepared.run,'work');
    writeFileSync(join(work,'package-lock.json'),'lock');
    const {createHash}=await import('node:crypto');
    const sha=data=>createHash('sha256').update(data).digest('hex');
    const manifest=runner.manifestWire({entries:[{path:Buffer.from('package-lock.json'),sha256:sha('lock'),executable:false,tracked:false}],excluded:[]});
    const request={run:prepared.run,nonce:'b'.repeat(32),argv,argvDigest:runner.digestArgv(argv),env:{},lock:sha('lock'),
      inputDigest:await runner.digestInput(work),manifest,manifestDigest:sha(JSON.stringify(manifest))};
    return {root,work,server,request,setTime:ms=>{time=ms;}};
  }
  it.each(classes.map(argv=>[argv]))('executes the fixed command and keeps original digest in the receipt %j', async argv => {
    const f=await runningFixture(argv);
    expect((await f.server.run(f.request)).code).toBe(5);
    expect(JSON.parse(readFileSync(join(f.work,'argv.json'),'utf8'))).toEqual(runner.executionArgv(argv).slice(2));
    const receipt=await f.server.finish(f.request);
    expect(receipt.argvDigest).toBe(runner.digestArgv(argv));
    expect((await f.server.telemetry()).recent[0]).toMatchObject({runId:f.request.run,code:5});
  });
  it('runs a five-second timer inside the runner and clears it after completion', async () => {
    const f=await runningFixture(command,{gate:true});
    let tick,notify,handle;
    const started=new Promise(done=>{notify=done;}),original=setInterval;
    const clear=vi.spyOn(globalThis,'clearInterval');
    const spy=vi.spyOn(globalThis,'setInterval').mockImplementation((fn,ms)=>{expect(ms).toBe(5000);tick=fn;notify();handle=original(fn,ms);return handle;});
    try {
      const pending=f.server.run(f.request);await started;
      f.setTime(now+7000);await tick();
      const telemetry=await f.server.telemetry();
      expect(telemetry).toMatchObject({sampledAtET:runner.easternTimestamp(now+7000),activeRuns:1});
      expect(telemetry.recent[0].stageMs.install).toBe(7000);
      writeFileSync(join(f.root,'release'),'yes');
      expect((await pending).code).toBe(5);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(handle);
    }finally{spy.mockRestore();clear.mockRestore();}
  });
});

describe('remote controls', () => {
  it('resolves every new default with provenance and rejects invalid values', () => {
    const defaults={maxConcurrent:8,backoffMs:120000,backoffFailures:3,maxLoadPerCore:0.8,minFreeRamPct:15};
    const standard=resolveAdmissionPolicy({});
    expect(standard.settings.remote).toMatchObject(defaults);
    for(const [key,value] of Object.entries(defaults)) {
      expect(standard.sources['remote.'+key]).toBe('standard');
      expect(formatAdmissionPolicy(standard)).toContain(`remote.${key}=${value} (standard)`);
      const configured=policy({[key]:key==='minFreeRamPct'?25:2});
      expect(configured.sources['remote.'+key]).toBe('platform');
      expect(policy({[key]:-1}).invalid).toContainEqual(expect.stringContaining('platform.remote.'+key));
    }
  });
  it.each([
    ['maxConcurrent',0],['maxConcurrent',1.5],['maxConcurrent',257],['backoffMs',86400001],['backoffMs',1.5],
    ['backoffFailures',0],['backoffFailures',1.5],['maxLoadPerCore',Infinity],['minFreeRamPct',101],
  ])('falls back to the named standard for invalid/oversized remote.%s=%s', (key,value) => {
    const configured=policy({[key]:value}),standard=resolveAdmissionPolicy({});
    expect(configured.settings.remote[key]).toBe(standard.settings.remote[key]);
    expect(configured.sources['remote.'+key]).toBe('standard');
    expect(formatAdmissionPolicy(configured)).toContain('invalid: platform.remote.'+key);
  });
  function fixture(remote={}) {
    const root=scratch(),lockRoot=join(root,'heavy');
    return {argv:command,policy:policy(remote),cwd:root,env:{},lockRoot,clock:()=>now,
      readTelemetry:vi.fn(async()=>sample()),remoteExec:vi.fn(async()=>({mode:'remote',code:0})),log:vi.fn()};
  }
  it('refreshes an idle server through SSH on the heavy-admission remote path after its cache expires',async()=>{
    const f=fixture({maxLoadPerCore:Number.MAX_VALUE,minFreeRamPct:0}),serverRoot=scratch();let time=now;
    const server=runner.createRunner({testRoot:serverRoot,clock:()=>time});
    const ssh=vi.fn((_file,_args,_options,done)=>server.telemetry().then(value=>done(null,JSON.stringify(value)),done));
    f.clock=()=>time;f.readTelemetry=options=>readForgeTelemetry({...options,exec:ssh});
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:0});
    time+=60000;
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:0});
    expect(ssh).toHaveBeenCalledTimes(2);
    expect(f.remoteExec).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(join(serverRoot,'receipts','telemetry.json'),'utf8')).sampledAtET).toBe(runner.easternTimestamp(time));
  });
  it('holds a separate remote slot during execution and releases on success without Mac heavy capacity', async () => {
    const f=fixture();
    f.remoteExec.mockImplementation(async()=>{
      expect(heldSlots({lockRoot:join(f.cwd,'remote'),cap:8})).toHaveLength(1);
      expect(heldSlots({lockRoot:f.lockRoot,cap:2})).toHaveLength(0);
      expect(existsSync(join(f.cwd,'remote','slot-0.unconfirmed'))).toBe(true);
      return {mode:'remote',code:0};
    });
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:0});
    expect(heldSlots({lockRoot:join(f.cwd,'remote'),cap:8})).toHaveLength(0);
    expect(existsSync(join(f.cwd,'remote','slot-0.unconfirmed'))).toBe(false);
  });
  it.each([
    ['forge-unreachable',null],['telemetry-stale',{age:30001}],['maxLoadPerCore',{loadPerCore:0.81}],['minFreeRamPct',{memFreePct:14}],
  ])('routes local with a named %s trigger and persisted backoff', async (trigger,patch) => {
    const f=fixture();
    f.readTelemetry.mockImplementation(async()=>patch===null?Promise.reject(new Error('offline')):
      {...sample(now-(patch.age??0)),...Object.fromEntries(Object.entries(patch).filter(([key])=>key!=='age'))});
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining(trigger));
    const next={...f,readTelemetry:vi.fn(async()=>sample())};
    expect(await runWithRemoteDecision(next)).toEqual({handled:false});
    expect(next.readTelemetry).not.toHaveBeenCalled();
  });
  it('caches one read across callers for 10 seconds, then rejects a stale sample', async () => {
    const f=fixture();
    await runWithRemoteDecision(f);await runWithRemoteDecision(f);
    expect(f.readTelemetry).toHaveBeenCalledTimes(1);
    await runWithRemoteDecision({...f,clock:()=>now+31000});
    expect(f.remoteExec).toHaveBeenCalledTimes(2);
  });
  it('validates freshness at completion of the SSH read, accepting a sample produced during the read', async () => {
    const f=fixture();let current=now;f.clock=()=>current;
    f.readTelemetry.mockImplementation(async()=>{current+=20;return sample(current);});
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:0});
    expect(f.remoteExec).toHaveBeenCalledTimes(1);
  });
  it('caches unreachable telemetry for ten seconds even with backoff disabled', async () => {
    const f=fixture({backoffMs:0});
    f.readTelemetry.mockRejectedValue(new Error('offline'));
    await runWithRemoteDecision(f);await runWithRemoteDecision(f);
    expect(f.readTelemetry).toHaveBeenCalledTimes(1);
    await runWithRemoteDecision({...f,clock:()=>now+10000});
    expect(f.readTelemetry).toHaveBeenCalledTimes(2);
    expect(f.remoteExec).not.toHaveBeenCalled();
  });
  it('quarantines unconfirmed slots across client calls instead of reclaiming their capacity', async () => {
    const f=fixture({maxConcurrent:1});
    f.remoteExec.mockResolvedValue({mode:'unconfirmed'});
    expect(await runWithRemoteDecision(f)).toEqual({handled:true,exitCode:124});
    expect(readFileSync(join(f.cwd,'remote','slot-0.unconfirmed'),'utf8')).toContain('unconfirmed');
    expect(heldSlots({lockRoot:join(f.cwd,'remote'),cap:1})).toHaveLength(1);
  });
  it('keeps a dispatched remote slot reserved after SIGKILL of its client while its job survives', async () => {
    const f=fixture({maxConcurrent:1});
    const admissionURL=new URL('../heavy-admission.mjs',import.meta.url).href;
    const runnerURL=new URL('../forge-exec-run.mjs',import.meta.url).href;
    const source=`
      import {spawn} from 'node:child_process';
      import {runWithRemoteDecision,resolveAdmissionPolicy} from ${JSON.stringify(admissionURL)};
      import {easternTimestamp} from ${JSON.stringify(runnerURL)};
      await runWithRemoteDecision({
        argv:${JSON.stringify(command)},cwd:${JSON.stringify(f.cwd)},env:{},lockRoot:${JSON.stringify(f.lockRoot)},
        clock:()=>${now},log:()=>{},
        policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',maxConcurrent:1}}}),
        readTelemetry:async()=>({sampledAtET:easternTimestamp(${now}),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]}),
        remoteExec:()=>new Promise((resolve,reject)=>{
          // Anchor to the test runner, so the bounded job outlives only this client.
          const job=spawn(process.execPath,['-e',${JSON.stringify(keepAliveScript({maxLifetimeMs:60_000}))}],{detached:true,stdio:'ignore'});
          job.on('error',reject);
          job.once('spawn',()=>{job.unref();process.send({stage:'dispatched',jobPid:job.pid});});
        }),
      });
    `;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{
      cwd:f.cwd,stdio:['ignore','ignore','ignore','ipc'],
    });
    const exited=once(child,'exit');
    let jobPid,timer;
    try {
      const ready=await Promise.race([
        once(child,'message').then(([message])=>message),
        exited.then(()=>{throw new Error('Client exited before dispatch');}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Client dispatch deadline exceeded')),10000);}),
      ]);
      clearTimeout(timer);
      jobPid=ready.jobPid;
      expect(ready.stage).toBe('dispatched');
      expect(Number.isSafeInteger(jobPid)&&jobPid>0).toBe(true);
      child.kill('SIGKILL');
      expect((await exited)[1]).toBe('SIGKILL');
      expect(()=>process.kill(jobPid,0)).not.toThrow();
      vi.useFakeTimers();vi.setSystemTime(now);
      const next=runWithRemoteDecision({...f,clock:Date.now});
      await vi.advanceTimersByTimeAsync(30000);
      expect(await next).toEqual({handled:false});
      expect(f.remoteExec).not.toHaveBeenCalled();
      expect(f.log).toHaveBeenCalledWith(expect.stringContaining('remote-full'));
      expect(existsSync(join(f.cwd,'remote','slot-0.unconfirmed'))).toBe(true);
      expect(()=>process.kill(jobPid,0)).not.toThrow();
    } finally {
      clearTimeout(timer);vi.useRealTimers();
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
      await exited;
      if(Number.isSafeInteger(jobPid))try{process.kill(jobPid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    }
  },15000);
  it.each([
    {mode:'remote',code:0},{mode:'remote',code:23},
    {mode:'not-started',terminated:true},{mode:'cancelled',terminated:true},
  ])('clears outstanding execution only after confirmed completion or termination: %j', async result => {
    const f=fixture({maxConcurrent:1});
    const marker=join(f.cwd,'remote','slot-0.unconfirmed');
    f.remoteExec.mockImplementation(async()=>{expect(existsSync(marker)).toBe(true);return result;});
    expect(await runWithRemoteDecision(f)).toEqual(result.mode==='remote'?{handled:true,exitCode:result.code}:{handled:false});
    expect(existsSync(marker)).toBe(false);
    expect(heldSlots({lockRoot:join(f.cwd,'remote'),cap:1})).toHaveLength(0);
  });
  it('refuses dispatch when exclusive outstanding-marker persistence fails, retaining existing evidence', async () => {
    const f=fixture({maxConcurrent:1}),remoteRoot=join(f.cwd,'remote');
    mkdirSync(remoteRoot);
    // existsSync cannot see a dangling link; exclusive creation must still refuse it.
    symlinkSync(join(f.cwd,'missing-evidence'),join(remoteRoot,'slot-0.unconfirmed'));
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('remote-execution-marker-unwritable'));
    expect(heldSlots({lockRoot:remoteRoot,cap:1})).toHaveLength(0);
  });
  it.each(['unconfirmed','forge-unreachable','copy-failed','forge-busy'])('persists three consecutive %s failures and resets on success', async reason => {
    const f=fixture();
    f.remoteExec.mockResolvedValue(reason==='unconfirmed'?{mode:'unconfirmed'}:{mode:'not-started',terminated:true,reason});
    for(let i=0;i<3;i++)await runWithRemoteDecision(f);
    const count=f.remoteExec.mock.calls.length;
    expect(count).toBe(3);
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).toHaveBeenCalledTimes(3);
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining(reason));
    f.remoteExec.mockResolvedValue({mode:'remote',code:0});
    await runWithRemoteDecision({...f,clock:()=>now+120001,readTelemetry:async()=>sample(now+120001)});
    const persisted=JSON.parse(readFileSync(join(f.cwd,'remote','health.json'),'utf8'));
    expect(persisted.failures).toBe(0);
  });
  it('waits at most 30 seconds when remote slots are full, then falls back locally', async () => {
    vi.useFakeTimers();vi.setSystemTime(now);
    const f=fixture({maxConcurrent:1});f.clock=Date.now;
    let resolve;
    const first=runWithRemoteDecision({...f,remoteExec:()=>new Promise(done=>{resolve=done;})});
    await vi.advanceTimersByTimeAsync(0);
    const second=runWithRemoteDecision(f);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await second).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('remote-full'));
    resolve({mode:'remote',code:0});await first;
  });
  it.each([
    ['overloaded',25000,{loadPerCore:0.81},'maxLoadPerCore'],
    ['low memory',25000,{memFreePct:14},'minFreeRamPct'],
    ['unreachable',25000,null,'forge-unreachable'],
    ['stale sample',25000,{age:30001},'telemetry-stale'],
    ['exact cache expiry',10000,{loadPerCore:0.81},'maxLoadPerCore'],
    ['healthy refresh',10000,{},null],
    ['still-cached health',9000,{},null],
  ])('rechecks health after waiting for a remote slot: %s', async (_name,waitMs,patch,trigger) => {
    vi.useFakeTimers();vi.setSystemTime(now);
    const f=fixture({maxConcurrent:1});f.clock=Date.now;
    const remoteRoot=join(f.cwd,'remote');
    let release;
    const first=runWithRemoteDecision({...f,remoteExec:()=>new Promise(done=>{release=done;})});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(heldSlots({lockRoot:remoteRoot,cap:1})).toHaveLength(1);
      const waiting=runWithRemoteDecision(f);
      await vi.advanceTimersByTimeAsync(waitMs-1000);
      expect(f.readTelemetry).toHaveBeenCalledTimes(1);
      expect(f.remoteExec).not.toHaveBeenCalled();
      // Flip health while all capacity is occupied, then allow the waiting caller
      // to acquire the slot on its next one-second poll.
      f.readTelemetry.mockImplementation(async()=>{
        if(patch===null)throw new Error('offline');
        const {age=0,...metrics}=patch;
        return {...sample(Date.now()-age),...metrics};
      });
      release({mode:'remote',code:0});await first;
      await vi.advanceTimersByTimeAsync(1000);
      expect(await waiting).toEqual(trigger?{handled:false}:{handled:true,exitCode:0});
      expect(f.readTelemetry).toHaveBeenCalledTimes(waitMs>=10000?2:1);
      expect(f.remoteExec).toHaveBeenCalledTimes(trigger?0:1);
      expect(heldSlots({lockRoot:remoteRoot,cap:1})).toHaveLength(0);
      expect(existsSync(join(remoteRoot,'slot-0.unconfirmed'))).toBe(false);
      if(trigger) {
        expect(f.log).toHaveBeenCalledWith(expect.stringContaining(trigger));
        const state=JSON.parse(readFileSync(join(remoteRoot,'health.json'),'utf8'));
        expect(state.trigger).toBe(trigger);
        expect(state.backoffUntil).toBeGreaterThan(Date.now());
        // A subsequent caller observes the persisted refusal without another read.
        expect(await runWithRemoteDecision(f)).toEqual({handled:false});
        expect(f.readTelemetry).toHaveBeenCalledTimes(2);
        expect(f.remoteExec).not.toHaveBeenCalled();
      }
    } finally {
      release?.({mode:'remote',code:0});await first;
    }
  });
  it('fails closed on corrupt persisted evidence and names local fallback', async () => {
    const f=fixture();mkdirSync(join(f.cwd,'remote'));
    writeFileSync(join(f.cwd,'remote','health.json'),'{}');
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.stringContaining('remote-health-unreadable'));
  });
});
