// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pickRemoteTarget, probeRemoteHosts } from '../remote-target.mjs';
import { resolveAdmissionPolicy, runWithRemoteDecision, formatAdmissionPolicy } from '../heavy-admission.mjs';
import { runRemote, defaultExec } from '../remote-exec.mjs';
import {keepAliveScript} from '../../lib/test-keepalive.mjs';
import { bindingEvidence, gitArgs } from './fixtures/forge-bound-git.mjs';
import { peekRemoteBreaker, checkRemoteHealth, remoteHealthFile } from '../forge-remote-health.mjs';
import { easternTimestamp } from '../forge-exec-run.mjs';

const hosts = [{alias:'mesa-01',root:'/srv/forge-exec'}, {alias:'forge',root:'/srv/forge-exec'}];
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function admission(remote = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR,'remote-target-')); roots.push(root);
  return { argv:['npm','run','test:unit','--','a.test.mjs'], cwd:root, lockRoot:join(root,'heavy'),
    env:{NODE_ENV:'test'}, policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',...remote}}}),
    log:vi.fn(), remoteExec:vi.fn(async () => ({mode:'remote',code:0})),
    readTelemetry:async () => ({sampledAtET:(await import('../forge-exec-run.mjs')).easternTimestamp(Date.now()),
      cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]}) };
}
describe('ordered remote targets', () => {
  it('respects order and picks healthy Mesa first with bounded noninteractive ssh', async () => {
    const exec=vi.fn(async () => ({code:0}));
    expect(await pickRemoteTarget({hosts,exec})).toEqual({...hosts[0],skipped:[]});
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toMatchObject({file:'ssh',args:['--','mesa-01','test -x /usr/local/libexec/forge-exec-run.mjs']});
    expect(exec.mock.calls[0][0].sshOptions).toEqual(expect.arrayContaining(['-o','ConnectTimeout=5','BatchMode=yes']));
    expect(probeRemoteHosts).toBeTypeOf('function');
  });
  it.each([[255,'ssh-unreachable'],[1,'runner-missing']])('skips code %s with reason %s', async (code,reason) => {
    const exec=vi.fn().mockResolvedValueOnce({code}).mockResolvedValueOnce({code:0});
    expect(await pickRemoteTarget({hosts,exec})).toEqual({...hosts[1],skipped:[{alias:'mesa-01',reason}]});
    expect(exec.mock.calls.map(([call])=>call.args[1])).toEqual(['mesa-01','forge']);
  });
  it('treats a thrown ssh failure as unreachable', async () => {
    const exec=vi.fn().mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce({code:0});
    expect((await pickRemoteTarget({hosts,exec})).skipped).toEqual([{alias:'mesa-01',reason:'ssh-unreachable'}]);
  });
  it('none healthy returns null; local fallback never dispatches an unhealthy job', async () => {
    const exec=vi.fn(async () => ({code:255}));
    expect(await pickRemoteTarget({hosts,exec})).toBeNull();
    const f=admission({hosts});
    expect(await runWithRemoteDecision({...f,targetExec:exec})).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('location=local reason=no-healthy-remote');
  });
  it('default setting dispatches forge and its root with no target probe', async () => {
    const f=admission(), targetExec=vi.fn();
    expect(f.policy.settings.remote.hosts).toEqual([hosts[1]]);
    expect(await runWithRemoteDecision({...f,targetExec})).toEqual({handled:true,exitCode:0,remoteResult:{mode:'remote',code:0}});
    expect(targetExec).not.toHaveBeenCalled();
    expect(f.remoteExec).toHaveBeenCalledWith(expect.objectContaining({host:'forge',root:'/srv/forge-exec'}));
  });
  it.each([hosts,[hosts[0]]].map(targets=>[targets]))('dispatches the selected host and root from %j', async targets => {
    const f=admission({hosts:targets}), targetExec=vi.fn(async()=>({code:0}));
    expect(await runWithRemoteDecision({...f,targetExec})).toEqual({handled:true,exitCode:0,remoteResult:{mode:'remote',code:0}});
    expect(f.remoteExec).toHaveBeenCalledWith(expect.objectContaining({host:'mesa-01',root:'/srv/forge-exec'}));
  });
  it('explicit default ignores object key order and adds no probe', async () => {
    const f=admission({hosts:[{root:'/srv/forge-exec',alias:'forge'}]}), targetExec=vi.fn();
    await runWithRemoteDecision({...f,targetExec});
    expect(targetExec).not.toHaveBeenCalled();
    expect(f.remoteExec).toHaveBeenCalledWith(expect.objectContaining({host:'forge',root:'/srv/forge-exec'}));
  });
  it('dry probe uses injected execution without running a job', async () => {
    const exec=vi.fn(async()=>({code:0}));
    expect(await probeRemoteHosts({hosts,exec})).toEqual({...hosts[0],skipped:[]});
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it.each([[],null,[{alias:'',root:'/srv/forge-exec'}],
    ...['-V','user@mesa','@mesa','_mesa','.mesa','mesa\n','bad;host'].map(alias=>[{alias,root:'/srv/forge-exec'}]),
    ...['/srv/mesa-exec','/','/srv/../srv/forge-exec','/srv/forge-exec/','relative','/srv/a b','/srv/$(id)','/srv/x;id'].map(root=>[{alias:'mesa',root}]),
    Array(33).fill(hosts[0])].map(value=>[value]))('invalid hosts %j disable remote dispatch and log local fallback', async value => {
    const f=admission({hosts:value}), targetExec=vi.fn();
    expect(f.policy.settings.remote.hosts).toEqual([]);
    expect(f.policy.settings.remote.enabled).toBe(false);
    expect(f.policy.invalid).toHaveLength(1);
    expect(formatAdmissionPolicy(f.policy)).toContain('invalid: platform.remote.hosts=');
    expect(await runWithRemoteDecision({...f,targetExec})).toEqual({handled:false});
    expect(targetExec).not.toHaveBeenCalled();
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('location=local reason=invalid-remote-hosts (platform)');
    expect(await pickRemoteTarget({hosts:value,exec:targetExec})).toBeNull();
    expect(targetExec).not.toHaveBeenCalled();
  });
  it('kills a hung probe at its execution deadline and treats it as ssh-unreachable', async () => {
    const exec=vi.fn(async call => {
      expect(call.timeout).toBe(10_000);
      if (call.args[1] === 'forge') return {code:0};
      // Exercise the production exec adapter with a child that ignores SIGTERM.
      return defaultExec({...call, file:process.execPath,
        args:['-e', keepAliveScript({prelude:"process.on('SIGTERM',()=>{});",maxLifetimeMs:5000})], timeout:100});
    });
    expect(await pickRemoteTarget({hosts,exec})).toEqual({...hosts[1],skipped:[{alias:'mesa-01',reason:'ssh-unreachable'}]});
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it('logs host configuration and its source', () => {
    const policy=resolveAdmissionPolicy({platform:{remote:{hosts}}});
    expect(formatAdmissionPolicy(policy)).toContain(`remote.hosts=${JSON.stringify(hosts)} (platform)`);
  });
  it('refuses an unsafe per-call root before any transport IO', async () => {
    const exec=vi.fn();
    expect(await runRemote({argv:['npm','run','test:unit','--','a.test.mjs'],root:'/srv/$(id)',exec,log:vi.fn()}))
      .toMatchObject({mode:'not-started',reason:'invalid-target'});
    expect(exec).not.toHaveBeenCalled();
  });
  it('retains Forge ops credentials with no key or identity arguments', async () => {
    const f=admission();
    const exec=vi.fn(async call => {
      if(call.file==='git') return bindingEvidence(call) ?? {code:0,stdout:Buffer.from(gitArgs(call).includes('HEAD')?'a'.repeat(40)+'\n':'')};
      if(call.file==='ssh' && call.args.at(-1)==='true') return {code:0};
      if(call.file==='ssh' && call.args.at(-1).endsWith(' bases')) return {code:254};
      if(call.file==='ssh' && call.args.at(-1).endsWith(' prepare')) return {code:1};
      throw new Error('Unexpected call');
    });
    await runRemote({argv:f.argv,cwd:f.cwd,env:{},exec,listFiles:async()=>[],sshOptions:[],log:vi.fn()});
    const calls=exec.mock.calls.map(([call])=>call).filter(call=>call.file==='ssh');
    expect(calls.some(call=>call.args.join(' ').includes('sudo -n -u ops /usr/local/libexec/forge-exec-run.mjs'))).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/IdentityFile|identity-file|"-i"/);
  });
});

describe('remote target gate, breaker and telemetry order', () => {
  const now = Date.parse('2026-11-26T20:00:00-05:00');
  const sample = (loadPerCore = 0.1) => ({sampledAtET:easternTimestamp(now),
    cores:8,loadPerCore,memFreePct:90,activeRuns:0,recent:[]});
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); });
  function fixture(remote = {}) {
    const f = admission({hosts,manifest:'legacy',...remote});
    writeFileSync(join(f.cwd, 'a.test.mjs'), 'export {};\n');
    return {...f,clock:()=>now,loadPerCore:()=>4,hostOverloaded:()=>false,
      targetExec:vi.fn(async()=>({code:0})),readTelemetry:vi.fn(async()=>sample()),
      readCapability:vi.fn(()=>true),onDecision:vi.fn()};
  }
  const remoteRoot = f => join(f.cwd, 'remote');
  function seed(f, host = 'mesa-01', over = {}) {
    mkdirSync(remoteRoot(f), {recursive:true});
    writeFileSync(remoteHealthFile(remoteRoot(f), host), JSON.stringify({v:1,lastReadAt:null,
      telemetry:null,failures:0,backoffUntil:now+60000,trigger:'maxLoadPerCore',...over}));
  }
  const rows = f => JSON.parse(readFileSync(join(f.lockRoot,'remote-fallbacks.jsonl'),'utf8').trim());
  const logs = f => f.log.mock.calls.flat().join('');
  const dispatchHost = f => f.remoteExec.mock.calls[0]?.[0].host;
  const probeHosts = f => f.targetExec.mock.calls.map(([call])=>call.args[1]);
  const telemetryHosts = f => f.readTelemetry.mock.calls.map(([call])=>call.host);

  it('breaker rejection skips without probing', async () => {
    const f=fixture(), onSkip=vi.fn();
    const breaker=vi.fn(async alias=>({open:alias==='mesa-01',reason:'backoff-maxLoadPerCore'}));
    const skipped=[{alias:'mesa-01',reason:'backoff-maxLoadPerCore'}];
    expect(await pickRemoteTarget({hosts,cwd:f.cwd,exec:f.targetExec,breaker,onSkip}))
      .toEqual({...hosts[1],skipped});
    expect(probeHosts(f)).toEqual(['forge']);
    expect(onSkip.mock.calls.map(([entry])=>entry)).toEqual(skipped);
  });
  it('admit rejection tries next host', async () => {
    const f=fixture(), onSkip=vi.fn();
    const admit=vi.fn(async({alias})=>alias==='mesa-01'?{ok:false,reason:'maxLoadPerCore',detail:'x'}:{ok:true});
    const skipped=[{alias:'mesa-01',reason:'maxLoadPerCore',detail:'x'}];
    expect(await pickRemoteTarget({hosts,cwd:f.cwd,exec:f.targetExec,admit,onSkip})).toEqual({...hosts[1],skipped});
    expect(onSkip.mock.calls.map(([entry])=>entry)).toEqual(skipped);
  });
  it.each([
    ...[null,undefined,{}, {ok:'yes'}, {ok:false}].map(value=>['admit',value,'admit-result-invalid']),
    ['admit',new Error('unreadable'),'remote-health-unreadable'],
    ...[null,undefined,{}, {open:'yes'}].map(value=>['breaker',value,'breaker-result-invalid']),
    ['breaker',new Error('unreadable'),'breaker-unreadable'],
  ])('malformed admission result fails closed: %s %j', async (hook,value,reason) => {
    const f=fixture(), onSkip=vi.fn(), admit=vi.fn(async()=>({ok:true}));
    const invalid=vi.fn(async()=>{if(value instanceof Error)throw value;return value;});
    expect(await pickRemoteTarget({hosts,cwd:f.cwd,exec:f.targetExec,admit,[hook]:invalid,onSkip})).toBeNull();
    expect(onSkip.mock.calls.map(([entry])=>entry)).toEqual(hosts.map(({alias})=>({alias,reason})));
    expect(f.targetExec).toHaveBeenCalledTimes(hook==='breaker'?0:2);
    if(hook==='breaker')expect(admit).not.toHaveBeenCalled();
  });
  it('open breaker without a reason uses breaker-open', async () => {
    const f=fixture(), onSkip=vi.fn();
    expect(await pickRemoteTarget({hosts,cwd:f.cwd,exec:f.targetExec,breaker:async()=>({open:true,reason:''}),onSkip})).toBeNull();
    expect(onSkip.mock.calls.map(([entry])=>entry)).toEqual(hosts.map(({alias})=>({alias,reason:'breaker-open'})));
    expect(f.targetExec).not.toHaveBeenCalled();
  });
  it.each(['healthy','open','probe-failed'])('pickRemoteTarget checks each target\'s breaker, then its probe, then its health, in host order (%s)', async mode => {
    const f=fixture(), events=[];
    const breaker=async alias=>{events.push(`breaker:${alias}`);return {open:mode==='open'&&alias==='mesa-01'};};
    const exec=async call=>{const alias=call.args[1];events.push(`probe:${alias}`);return {code:mode==='probe-failed'&&alias==='mesa-01'?255:0};};
    const admit=async({alias})=>{events.push(`admit:${alias}`);return {ok:true};};
    expect((await pickRemoteTarget({hosts,cwd:f.cwd,exec,breaker,admit})).alias).toBe(mode==='healthy'?'mesa-01':'forge');
    expect(events).toEqual(mode==='healthy'?['breaker:mesa-01','probe:mesa-01','admit:mesa-01']:
      mode==='open'?['breaker:mesa-01','breaker:forge','probe:forge','admit:forge']:
        ['breaker:mesa-01','probe:mesa-01','breaker:forge','probe:forge','admit:forge']);
  });
  it('a target whose breaker is open is skipped before any probe', async () => {
    const f=fixture();seed(f);
    await runWithRemoteDecision(f);
    expect(probeHosts(f)).toEqual(['forge']);
    expect(telemetryHosts(f)).toEqual(['forge']);
    expect(dispatchHost(f)).toBe('forge');
    expect(logs(f)).toContain('skipped=[{"alias":"mesa-01","reason":"backoff-maxLoadPerCore"}]');
  });
  it('a target failing the telemetry check is never selected; the next target is tried', async () => {
    const f=fixture();f.readTelemetry.mockImplementation(async({host})=>sample(host==='mesa-01'?2:0.1));
    await runWithRemoteDecision(f);
    expect(probeHosts(f)).toEqual(['mesa-01','forge']);
    expect(telemetryHosts(f)).toEqual(['mesa-01','forge']);
    expect(dispatchHost(f)).toBe('forge');
    expect(logs(f)).toContain('skipped=[{"alias":"mesa-01","reason":"maxLoadPerCore"}]');
  });
  it('no probe runs when the routing decision is already local, and its reason is kept', async () => {
    const f=fixture(),base=f.cwd;
    f.cwd=join(base,'checkout');mkdirSync(f.cwd);f.lockRoot=join(f.cwd,'heavy');
    writeFileSync(join(base,'outside.test.mjs'),'export {};\n');
    f.argv=['npm','run','test:unit','--','../outside.test.mjs'];
    f.targetExec.mockResolvedValue({code:255});
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.targetExec).not.toHaveBeenCalled();
    expect(f.readTelemetry).not.toHaveBeenCalled();
    expect(f.readCapability).not.toHaveBeenCalled();
    expect(existsSync(remoteRoot(f))).toBe(false);
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.onDecision).toHaveBeenCalledTimes(1); expect(f.onDecision).toHaveBeenCalledWith(expect.objectContaining({remote:false,reason:expect.stringMatching(/needs-git/)}));
    expect(rows(f)).toMatchObject({reason:'needs-git'});
    expect(logs(f)).not.toContain('no-healthy-remote');
  });
  it.each([
    ['remote disabled',{enabled:false},()=>4,/remote\.enabled=false/],
    ['above-threshold below threshold',{mode:'above-threshold'},()=>0.1,/<=/],
    ['unreadable load',{mode:'above-threshold'},()=>{throw new Error('load unavailable');},/load-unreadable/],
  ])('%s: no probe, health or capability read', async(_name,remote,loadPerCore,reason)=>{
    const f=fixture(remote);
    expect(await runWithRemoteDecision({...f,loadPerCore})).toEqual({handled:false});
    expect(f.targetExec).not.toHaveBeenCalled();
    expect(f.readTelemetry).not.toHaveBeenCalled();
    expect(f.readCapability).not.toHaveBeenCalled();
    expect(existsSync(remoteRoot(f))).toBe(false);
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.onDecision).toHaveBeenCalledTimes(1); expect(f.onDecision).toHaveBeenCalledWith({remote:false,reason:expect.stringMatching(reason)});
  });
  it('overload override routes through ordered selection', async()=>{
    const f=fixture({mode:'above-threshold'});
    await runWithRemoteDecision({...f,loadPerCore:()=>0.1,hostOverloaded:()=>true});
    expect(probeHosts(f)).toEqual(['mesa-01']);
    expect(dispatchHost(f)).toBe('mesa-01');
    expect(f.onDecision).toHaveBeenCalledTimes(1); expect(f.onDecision).toHaveBeenCalledWith({remote:true,reason:expect.stringMatching(/host overloaded/)});
  });
  it('Mesa-only: an open Mesa breaker runs local with no-healthy-remote and never contacts forge', async()=>{
    const f=fixture({hosts:[hosts[0]]});seed(f);
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.targetExec).not.toHaveBeenCalled();
    expect(f.readTelemetry).not.toHaveBeenCalled();
    expect(f.readCapability).not.toHaveBeenCalled();
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(logs(f)).toContain('location=local reason=no-healthy-remote');
    expect(rows(f)).toMatchObject({reason:'no-healthy-remote',detail:JSON.stringify([{alias:'mesa-01',reason:'backoff-maxLoadPerCore'}])});
    expect(existsSync(remoteHealthFile(remoteRoot(f),'forge'))).toBe(false);
  });
  it('Mesa-only: failing telemetry runs local as no-healthy-remote with no forge fallback', async()=>{
    const f=fixture({hosts:[hosts[0]]});f.readTelemetry.mockResolvedValue(sample(2));
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(probeHosts(f)).toEqual(['mesa-01']);
    expect(telemetryHosts(f)).toEqual(['mesa-01']);
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(rows(f)).toMatchObject({reason:'no-healthy-remote',detail:JSON.stringify([{alias:'mesa-01',reason:'maxLoadPerCore'}])});
    expect(existsSync(remoteHealthFile(remoteRoot(f),'forge'))).toBe(false);
  });
  it('records every failed target in order in the fallback detail', async()=>{
    const f=fixture();f.targetExec.mockResolvedValueOnce({code:1}).mockResolvedValueOnce({code:255});
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(rows(f)).toMatchObject({reason:'no-healthy-remote',detail:JSON.stringify([
      {alias:'mesa-01',reason:'runner-missing'},{alias:'forge',reason:'ssh-unreachable'}])});
    expect(f.readTelemetry).not.toHaveBeenCalled();
    expect(f.remoteExec).not.toHaveBeenCalled();
  });
  it.each([false,true])('capability-dependent needs-git downgrade happens after selection and reads the selected host\'s capability (%s)', async capable=>{
    const f=fixture({transport:'git-bundle'}), events=[];
    writeFileSync(join(f.cwd,'git.test.mjs'), "import {execSync} from 'node:child_process'; execSync('git status');\n");
    f.argv=['npm','run','test:unit','--','git.test.mjs'];
    f.targetExec.mockImplementation(async call=>{events.push(`probe:${call.args[1]}`);return {code:0};});
    f.readTelemetry.mockImplementation(async({host})=>{events.push(`health:${host}`);return sample();});
    f.readCapability.mockImplementation(({host})=>{events.push(`capability:${host}`);return capable;});
    await runWithRemoteDecision(f);
    expect(probeHosts(f)).toEqual(['mesa-01']);
    expect(f.readCapability).toHaveBeenCalledTimes(1); expect(f.readCapability).toHaveBeenCalledWith({root:remoteRoot(f),host:'mesa-01',clock:f.clock,unknownOk:true});
    expect(events).toEqual(['probe:mesa-01','health:mesa-01','capability:mesa-01']);
    if(capable)expect(dispatchHost(f)).toBe('mesa-01');
    else {
      expect(f.remoteExec).not.toHaveBeenCalled();
      expect(rows(f)).toMatchObject({reason:'needs-git'});
      expect(logs(f)).not.toContain('no-healthy-remote');
    }
  });
  it('a fresh probe failure is not outranked by a fresh cached health entry', async()=>{
    const f=fixture();seed(f,'mesa-01',{backoffUntil:0,trigger:'',lastReadAt:now,telemetry:sample()});
    f.targetExec.mockResolvedValueOnce({code:255}).mockResolvedValueOnce({code:0});
    await runWithRemoteDecision(f);
    expect(dispatchHost(f)).toBe('forge');
    expect(telemetryHosts(f)).toEqual(['forge']);
    expect(logs(f)).toContain('skipped=[{"alias":"mesa-01","reason":"ssh-unreachable"}]');
  });
  it('both healthy: Mesa is picked and Forge is never probed or health-checked', async()=>{
    const f=fixture();
    await runWithRemoteDecision(f);
    expect(probeHosts(f)).toEqual(['mesa-01']);
    expect(telemetryHosts(f)).toEqual(['mesa-01']);
    expect(dispatchHost(f)).toBe('mesa-01');
    expect(existsSync(remoteHealthFile(remoteRoot(f),'forge'))).toBe(false);
  });
  it('a breaker that opens between peek and admit is caught by the health check', async()=>{
    const f=fixture(), onSkip=vi.fn();mkdirSync(remoteRoot(f));
    const exec=async call=>{if(call.args[1]==='mesa-01')seed(f);return {code:0};};
    const result=await pickRemoteTarget({hosts,cwd:f.cwd,exec,onSkip,
      breaker:host=>peekRemoteBreaker({root:remoteRoot(f),host,clock:f.clock}),
      admit:({alias})=>checkRemoteHealth({root:remoteRoot(f),host:alias,settings:f.policy.settings.remote,
        clock:f.clock,readTelemetry:f.readTelemetry,ping:async()=>false})});
    expect(result).toEqual({...hosts[1],skipped:[{alias:'mesa-01',reason:'backoff-maxLoadPerCore'}]});
    expect(telemetryHosts(f)).toEqual(['forge']);
    expect(onSkip).toHaveBeenCalledTimes(1); expect(onSkip).toHaveBeenCalledWith(result.skipped[0]);
  });
  it.each([true,false])('an unreachable backoff is re-probed and lifted by a good ping (%s)', async reachable=>{
    const f=fixture(), ping=vi.fn(async()=>reachable);seed(f,'mesa-01',{trigger:'forge-unreachable'});
    const result=await pickRemoteTarget({hosts,cwd:f.cwd,exec:f.targetExec,
      breaker:host=>peekRemoteBreaker({root:remoteRoot(f),host,clock:f.clock}),
      admit:({alias})=>checkRemoteHealth({root:remoteRoot(f),host:alias,settings:f.policy.settings.remote,
        clock:f.clock,readTelemetry:f.readTelemetry,ping})});
    expect(result.alias).toBe(reachable?'mesa-01':'forge');
    expect(probeHosts(f)).toEqual(reachable?['mesa-01']:['mesa-01','forge']);
    expect(ping).toHaveBeenCalledTimes(1); expect(ping).toHaveBeenCalledWith({host:'mesa-01'});
    expect(telemetryHosts(f)).toEqual(reachable?['mesa-01']:['forge']);
    if(reachable)expect(JSON.parse(readFileSync(remoteHealthFile(remoteRoot(f),'mesa-01'),'utf8')).trigger).toBe('');
    else expect(result.skipped).toEqual([{alias:'mesa-01',reason:'backoff-forge-unreachable',detail:'60000ms left'}]);
  });
});
