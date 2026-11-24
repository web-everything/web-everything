// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pickRemoteTarget, probeRemoteHosts } from '../remote-target.mjs';
import { resolveAdmissionPolicy, runWithRemoteDecision, formatAdmissionPolicy } from '../heavy-admission.mjs';
import { runRemote, defaultExec } from '../remote-exec.mjs';
import {keepAliveScript} from '../../lib/test-keepalive.mjs';
import { bindingEvidence, gitArgs } from './fixtures/forge-bound-git.mjs';

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
