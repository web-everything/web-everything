// @vitest-environment node
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveAdmissionPolicy, runWithRemoteDecision} from '../heavy-admission.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';

const roots=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('with no forge default, the default list dispatches its own alias after a successful readiness probe',async()=>{
  const cwd=mkdtempSync(join(process.env.TMPDIR,'remote-default-host-'));roots.push(cwd);
  writeFileSync(join(cwd,'a.test.mjs'),'export {};\n');
  const now=Date.parse('2026-11-26T20:00:00-05:00');vi.spyOn(Date,'now').mockReturnValue(now);
  const targetExec=vi.fn(async()=>({code:0})),readCapability=vi.fn(()=>true),remoteExec=vi.fn(async()=>({mode:'remote',code:0}));
  const policy=resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',manifest:'legacy'}}});
  expect(policy.settings.remote.hosts).toEqual([{alias:'mesa-01',root:'/srv/forge-exec'}]);
  expect(await runWithRemoteDecision({argv:['npm','run','test:unit','--','a.test.mjs'],cwd,
    lockRoot:join(cwd,'heavy'),env:{},policy,clock:()=>now,loadPerCore:()=>4,hostOverloaded:()=>false,
    targetExec,readCapability,remoteExec,log:vi.fn(),readTelemetry:async()=>({
      sampledAtET:easternTimestamp(now),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]})}))
    .toEqual({handled:true,exitCode:0,remoteResult:{mode:'remote',code:0}});
  expect(targetExec).toHaveBeenCalledTimes(1);
  expect(readCapability).toHaveBeenCalledTimes(1); expect(readCapability).toHaveBeenCalledWith(expect.objectContaining({host:'mesa-01'}));
  expect(remoteExec).toHaveBeenCalledTimes(1); expect(remoteExec).toHaveBeenCalledWith(expect.objectContaining({host:'mesa-01',root:'/srv/forge-exec'}));
});
