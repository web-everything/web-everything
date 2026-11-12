// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, utimesSync} from 'node:fs';
import {join} from 'node:path';
import {runWithRemoteDecision, resolveAdmissionPolicy, formatAdmissionPolicy, heldSlots,
  tryAcquireSlot, releaseOwnedSlot, tryAcquireRemoteUnits, resolveRemoteSlotUnits} from '../heavy-admission.mjs';
import {lockDirFor} from '../file-locks.mjs';
import {easternTimestamp, elasticRunLimits, elasticScopeArgv, parseTelemetry} from '../forge-exec-run.mjs';

const roots=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(remote={}) {
  const root=mkdtempSync(join(process.env.TMPDIR,'slot-units-'));roots.push(root);
  let now=Date.now();
  const telemetry={sampledAtET:easternTimestamp(now),cores:32,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]};
  const f={argv:['npm','run','test:unit'],env:{},cwd:root,lockRoot:join(root,'heavy'),
    policy:resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',maxConcurrent:4,...remote}}}),
    readTelemetry:async()=>({...telemetry,sampledAtET:easternTimestamp(now)}),
    clock:()=>now,sleep:vi.fn(async ms=>{now+=ms;}),hostOverloaded:()=>false,log:vi.fn(),
    remoteExec:vi.fn(async()=>({mode:'remote',code:0}))};
  return {...f,root,telemetry,remoteRoot:join(root,'remote')};
}
const units=(policy,extra={})=>resolveRemoteSlotUnits({policy,kind:'FULL',telemetry:{activeRuns:0},priority:false,...extra});

describe('R324 elastic remote slot units',()=>{
  it('FULL takes three units when idle and releases every slot and marker',async()=>{
    const f=fixture();
    f.remoteExec.mockImplementation(async request=>{
      expect(request.slotUnits).toBe(3);
      expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(3);
      expect(readdirSync(f.remoteRoot).filter(n=>n.endsWith('.unconfirmed'))).toHaveLength(3);
      request.onRun('r-'+'a'.repeat(32));
      return {mode:'remote',code:0};
    });
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
    expect(f.log.mock.calls.flat().join('')).toContain('remote.slotUnits=3 (setting;');
    expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(0);
    expect(readdirSync(f.remoteRoot).filter(n=>n.includes('.unconfirmed'))).toEqual([]);
  });
  it('FULL waits then falls back remote-units-unavailable with fewer than k free',async()=>{
    const f=fixture();
    for(let i=0;i<2;i++)tryAcquireSlot({lockRoot:f.remoteRoot,cap:4,slots:[i],owner:'occupied'+i,nowMs:f.clock(),nowIso:new Date(f.clock()).toISOString()});
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.sleep).toHaveBeenCalled();
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-units-unavailable');
    expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(2);
  });
  it('overload extension remains bounded and releases partial elastic reservations',async()=>{
    const f=fixture();f.hostOverloaded=()=>true;f.timeoutMs=35000;
    for(let i=0;i<2;i++)tryAcquireSlot({lockRoot:f.remoteRoot,cap:4,slots:[i],owner:'occupied'+i,nowMs:f.clock(),nowIso:new Date(f.clock()).toISOString()});
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-units-unavailable');
    expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(2);
    expect(f.sleep.mock.calls.reduce((sum,[ms])=>sum+ms,0)).toBe(35000);
  });
  it('admits a scoped run while FULL holds k units and capacity remains',async()=>{
    const f=fixture();
    f.remoteExec.mockImplementation(async()=>{
      const scoped={...f,argv:['npm','run','test:unit','--','a.test.mjs'],remoteExec:vi.fn(async request=>{
        expect(request.slotUnits).toBe(1);
        expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(4);
        return {mode:'remote',code:0};
      })};
      expect(await runWithRemoteDecision(scoped)).toMatchObject({handled:true});
      return {mode:'remote',code:0};
    });
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
  });
  it('elasticity requires priority or idle Forge; scoped jobs always use one',()=>{
    const f=fixture();
    expect(units(f.policy).units).toBe(3);
    expect(units(f.policy,{telemetry:{activeRuns:1}}).units).toBe(1);
    expect(units(f.policy,{telemetry:{activeRuns:1},priority:true}).units).toBe(3);
    expect(units(f.policy,{kind:'files',priority:true}).units).toBe(1);
    expect(units(fixture({elasticSlots:{enabled:false}}).policy).units).toBe(1);
  });
  it('derives auto units from the actual quota keys: floor(2800% / 800%) = 3',()=>{
    expect(units(fixture().policy,{telemetry:{activeRuns:0,limits:{parent:{cpuQuota:'2800%'},slot:{cpuQuota:'800%'}}}})).toMatchObject({units:3,source:'telemetry'});
  });
  it('all-or-none releases a partial acquisition and rolls back on read errors',()=>{
    const acquire=vi.fn().mockReturnValueOnce({ok:true,slot:0}).mockReturnValueOnce({ok:false});
    const release=vi.fn();
    expect(tryAcquireRemoteUnits({units:3,slots:[0,1,2],acquire,release})).toMatchObject({ok:false});
    expect(release).toHaveBeenCalledTimes(1);
    acquire.mockReset().mockReturnValueOnce({ok:true,slot:0}).mockImplementationOnce(()=>{throw Error('unreadable');});
    expect(()=>tryAcquireRemoteUnits({units:3,slots:[0,1,2],acquire,release})).toThrow('unreadable');
    expect(release).toHaveBeenCalledTimes(2);
  });
  it.each([null,{parent:{cpuQuota:'bad'},slot:{cpuQuota:'800%'}}])('unreadable limits fail closed: %j',limits=>{
    expect(()=>units(fixture().policy,{telemetry:{activeRuns:0,limits}})).toThrow();
  });
  it('unreadable telemetry limits fall back without dispatch or reservations',async()=>{
    const f=fixture();f.telemetry.limits=null;
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-slot-unreadable');
    expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(0);
  });
  it('priority repair receives k units even when Forge is busy',async()=>{
    const f=fixture();f.telemetry.activeRuns=1;f.env.WE_HEAVY_SESSION='main-fix-abcdef1';
    f.remoteExec.mockImplementation(async request=>{
      expect(request.slotUnits).toBe(3);
      return {mode:'remote',code:0};
    });
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
  });
  it('unconfirmed execution retains all k markers for the reaper',async()=>{
    const f=fixture();f.remoteExec.mockResolvedValue({mode:'unconfirmed'});
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:124});
    expect(readdirSync(f.remoteRoot).filter(n=>n.endsWith('.unconfirmed'))).toHaveLength(3);
  });
  it('runner multiplies per-slot CPU, memory and worker budget within the parent ceiling',()=>{
    const limits={parent:{cpuQuota:'2800%',memoryMax:'56G'},slot:{cpuQuota:'800%',memoryMax:'12G'}};
    expect(elasticRunLimits(limits,1,3)).toMatchObject({cpus:24,cpuQuota:'2400%',memoryMax:'36G'});
    expect(()=>elasticRunLimits(limits,1,4)).toThrow();
    expect(()=>elasticRunLimits(limits,1,NaN)).toThrow();
  });
  it('limits becoming unreadable during the wait prevent dispatch and release reservations',async()=>{
    const f=fixture();
    for(let i=0;i<2;i++)tryAcquireSlot({lockRoot:f.remoteRoot,cap:4,slots:[i],owner:'occupied'+i,nowMs:f.clock(),nowIso:new Date(f.clock()).toISOString()});
    const advance=f.sleep.getMockImplementation();
    f.sleep.mockImplementation(async ms=>{
      await advance(ms);
      if(f.sleep.mock.calls.length===10){
        f.telemetry.limits=null;
        for(let i=0;i<2;i++)releaseOwnedSlot({lockRoot:f.remoteRoot,cap:4,owner:'occupied'+i,fastSlots:0});
      }
    });
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-slot-unreadable');
    expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toEqual([]);
  });
  it('accepts the optional limits telemetry extension while preserving legacy telemetry',()=>{
    const f=fixture(),limits={parent:{cpuQuota:'2800%'},slot:{cpuQuota:'800%'}};
    expect(parseTelemetry(JSON.stringify(f.telemetry))).not.toHaveProperty('limits');
    expect(parseTelemetry(JSON.stringify({...f.telemetry,limits})).limits).toEqual(limits);
    expect(parseTelemetry(JSON.stringify({...f.telemetry,limits:null})).limits).toBeNull();
  });
  it('unreadable slot counts fail closed without remote dispatch',async()=>{
    const f=fixture();f.policy.settings.remote.maxConcurrent=NaN;
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-slot-unreadable');
  });
  it('corrupt slot metadata fails closed without reclaim or dispatch',async()=>{
    const f=fixture(),dir=lockDirFor(f.remoteRoot,'slot-0');
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'lock.json'),'broken');
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-slot-unreadable');
  });
  it('transient elastic scope applies multiplied quotas under the parent slice',()=>{
    const limits={parent:{cpuQuota:'2800%',memoryMax:'56G'},slot:{cpuQuota:'800%',memoryMax:'12G'}};
    const options={limits,slot:1,unit:'forge-exec-run-'+'a'.repeat(16),source:'source',json:'{}',sudo:false};
    expect(elasticScopeArgv({...options,units:3})).toEqual(expect.arrayContaining([
      '--slice=forge-exec.slice','--property=CPUQuota=2400%','--property=MemoryMax=36G','--property=MemorySwapMax=0']));
    expect(elasticScopeArgv(options)).toContain('--slice=forge-exec-1.slice');
    expect(()=>elasticRunLimits({slot:limits.slot},1,3)).toThrow();
  });
  it('heartbeat refreshes every unit during an elastic execution',async()=>{
    const f=fixture();vi.useFakeTimers();
    try {
      f.remoteExec.mockImplementation(async()=>{
        await vi.advanceTimersByTimeAsync(60000);
        const held=heldSlots({lockRoot:f.remoteRoot,cap:4});
        expect(held).toHaveLength(3);
        for(const entry of held)expect(Date.parse(entry.heartbeatAt)).toBeGreaterThan(f.clock());
        return {mode:'remote',code:0};
      });
      expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
    }finally{vi.useRealTimers();}
  });
  it.each(['SIGTERM','SIGINT','SIGHUP'])('%s cancels and releases all units on confirmed termination',async signal=>{
    const f=fixture();
    f.remoteExec.mockImplementation(async request=>{
      const result=new Promise(resolve=>request.cancelSignal.addEventListener('abort',()=>resolve({mode:'cancelled',terminated:true}),{once:true}));
      process.emit(signal);return result;
    });
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,signal});
    expect(heldSlots({lockRoot:f.remoteRoot,cap:4})).toHaveLength(0);
    expect(readdirSync(f.remoteRoot).filter(n=>n.includes('.unconfirmed'))).toEqual([]);
  });
  it('logs setting provenance and supports fixed/absent/invalid kind settings',()=>{
    const f=fixture({slotUnitsByKind:{FULL:2},autoSlotUnits:4});
    expect(units(f.policy)).toMatchObject({units:2,source:'setting'});
    expect(units(f.policy,{kind:'soak'}).units).toBe(1);
    expect(formatAdmissionPolicy(f.policy)).toContain('remote.slotUnitsByKind={"FULL":2} (platform)');
    expect(formatAdmissionPolicy(f.policy)).toContain('remote.elasticSlots.enabled=true (standard)');
    expect(units(fixture({slotUnitsByKind:{FULL:999999}}).policy).units).toBe(1);
    expect(units(fixture().policy)).toMatchObject({units:3,source:'setting'});
  });
  it('derives auto units from distinct quota numbers: floor(3000% / 700%) = 4, not round or ceil',()=>{
    const policy=fixture({maxConcurrent:8}).policy,quota=(parent,slot)=>({activeRuns:0,limits:{parent:{cpuQuota:parent},slot:{cpuQuota:slot}}});
    expect(units(policy,{telemetry:quota('3000%','700%')})).toMatchObject({units:4,source:'telemetry'});
    expect(units(policy,{telemetry:quota('3500%','1200%')})).toMatchObject({units:2,source:'telemetry'});
    expect(()=>units(policy,{telemetry:quota('500%','800%')})).toThrow('Unreadable quota count');
  });
  it.each([
    ['telemetry quota above the client cap',{maxConcurrent:4},{limits:{parent:{cpuQuota:'2800%'},slot:{cpuQuota:'100%'}}},4,'telemetry'],
    ['fixed kind setting above the client cap',{maxConcurrent:2,slotUnitsByKind:{FULL:6}},{},2,'setting'],
    ['auto fallback setting above the client cap',{maxConcurrent:2,autoSlotUnits:5},{},2,'setting'],
  ])('clamps granted units to remote.maxConcurrent: %s',(_name,remote,extra,expectedUnits,source)=>{
    expect(units(fixture(remote).policy,{telemetry:{activeRuns:0,...extra}})).toEqual({units:expectedUnits,source});
  });
  it('logs telemetry and default provenance for the granted units',async()=>{
    const telemetry=fixture();telemetry.telemetry.limits={parent:{cpuQuota:'3000%'},slot:{cpuQuota:'1000%'}};
    expect(await runWithRemoteDecision(telemetry)).toMatchObject({handled:true});
    expect(telemetry.log.mock.calls.flat().join('')).toContain('remote.slotUnits=3 (telemetry;');
    const disabled=fixture({elasticSlots:{enabled:false}});
    expect(await runWithRemoteDecision(disabled)).toMatchObject({handled:true});
    expect(disabled.log.mock.calls.flat().join('')).toContain('remote.slotUnits=1 (default;');
  });
  it('a slot dir whose lock.json is still being written is initializing, not unreadable',async()=>{
    const f=fixture();mkdirSync(lockDirFor(f.remoteRoot,'slot-0'),{recursive:true});
    f.remoteExec.mockImplementation(async request=>{
      expect(request.slotUnits).toBe(3);
      expect(heldSlots({lockRoot:f.remoteRoot,cap:4}).map(entry=>entry.path)).not.toContain('slot-0');
      return {mode:'remote',code:0};
    });
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
    expect(f.log.mock.calls.flat().join('')).not.toContain('remote-slot-unreadable');
  });
  it('a young slot dir holding the torn empty lock.json is initializing, not unreadable',async()=>{
    const f=fixture(),dir=lockDirFor(f.remoteRoot,'slot-0');
    mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'lock.json'),'');
    f.remoteExec.mockResolvedValue({mode:'remote',code:0});
    expect(await runWithRemoteDecision(f)).toMatchObject({handled:true,exitCode:0});
    expect(f.log.mock.calls.flat().join('')).not.toContain('remote-slot-unreadable');
  });
  it('a corrupt non-empty lock.json and a future-mtime entryless dir both fail closed',async()=>{
    const corrupt=fixture(),cdir=lockDirFor(corrupt.remoteRoot,'slot-0');
    mkdirSync(cdir,{recursive:true});writeFileSync(join(cdir,'lock.json'),'{not json');
    expect(await runWithRemoteDecision(corrupt)).toEqual({handled:false});
    const future=fixture(),fdir=lockDirFor(future.remoteRoot,'slot-0'),later=new Date(Date.now()+3600000);
    mkdirSync(fdir,{recursive:true});utimesSync(fdir,later,later);
    expect(await runWithRemoteDecision(future)).toEqual({handled:false});
    for(const f of [corrupt,future]){
      expect(f.remoteExec).not.toHaveBeenCalled();
      expect(f.log.mock.calls.flat().join('')).toContain('remote-slot-unreadable');
    }
  });
  it('an entryless slot dir past the crash grace fails closed',async()=>{
    const f=fixture(),dir=lockDirFor(f.remoteRoot,'slot-0'),old=new Date(Date.now()-60000);
    mkdirSync(dir,{recursive:true});utimesSync(dir,old,old);
    expect(await runWithRemoteDecision(f)).toEqual({handled:false});
    expect(f.remoteExec).not.toHaveBeenCalled();
    expect(f.log.mock.calls.flat().join('')).toContain('remote-slot-unreadable');
  });
  it('transient scope carries multiplied TasksMax, unlimited caps and the slot IOWeight',()=>{
    const slot={cpuQuota:'800%',memoryMax:'12G',tasksMax:2048,ioWeight:250};
    const options={limits:{parent:{cpuQuota:'2800%',memoryMax:'56G'},slot},slot:1,unit:'forge-exec-run-'+'a'.repeat(16),source:'source',json:'{}',sudo:false};
    expect(elasticScopeArgv({...options,units:3})).toEqual(expect.arrayContaining(['--property=TasksMax=6144','--property=IOWeight=250']));
    const unlimited=elasticScopeArgv({...options,limits:{...options.limits,slot:{...slot,tasksMax:'infinity',memoryMax:'infinity'}},units:3});
    expect(unlimited).toEqual(expect.arrayContaining(['--property=TasksMax=infinity','--property=MemoryMax=infinity']));
    expect(elasticScopeArgv(options).some(arg=>arg.startsWith('--property='))).toBe(false);
  });
  it('scales every finite memory suffix and preserves an unlimited memory cap',()=>{
    const limits=memoryMax=>({parent:{cpuQuota:'2800%'},slot:{cpuQuota:'800%',memoryMax}});
    expect(elasticRunLimits(limits('infinity'),1,3).memoryMax).toBe('infinity');
    expect(elasticRunLimits(limits('infinity'),1,1).memoryMax).toBe('infinity');
    expect(elasticRunLimits(limits('512M'),1,3).memoryMax).toBe('1536M');
    expect(()=>elasticRunLimits(limits('bad'),1,3)).toThrow('Unreadable slot memory limit');
  });
  it('bounds the scaled memory grant by a finite parent memory ceiling',()=>{
    const limits=(slotMemory,parentMemory)=>({parent:{cpuQuota:'2800%',memoryMax:parentMemory},slot:{cpuQuota:'100%',memoryMax:slotMemory}});
    // 28 x 12G = 336G passes the CPU check (28 x 100% = 2800%) but exceeds the 56G parent.
    expect(()=>elasticRunLimits(limits('12G','56G'),1,28)).toThrow('Slot units exceed parent memory limit');
    expect(elasticRunLimits(limits('12G','56G'),1,4).memoryMax).toBe('48G');
    expect(elasticRunLimits(limits('12G','56G'),1,1).memoryMax).toBe('12G');        // a single slot is never scaled
    expect(elasticRunLimits(limits('1G','1024M'),1,1).memoryMax).toBe('1G');
    expect(()=>elasticRunLimits(limits('1G','1000M'),1,2)).toThrow('Slot units exceed parent memory limit'); // 2G > ~1G across suffixes
    expect(elasticRunLimits(limits('12G','infinity'),1,28).memoryMax).toBe('336G'); // unlimited parent: nothing to bound
    expect(elasticRunLimits(limits('infinity','56G'),1,28).memoryMax).toBe('infinity');
    expect(()=>elasticRunLimits(limits('12G','garbage'),1,2)).toThrow('Slot units exceed parent memory limit'); // unreadable ceiling fails closed
  });
});

describe('non-elastic kinds never need telemetry (remote-slot-unreadable race)',()=>{
  const policy=resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',maxConcurrent:4}}});
  it.each(['files','selected','build','other','verify'])('%s runs on one unit when telemetry was just rewritten as null',kind=>{
    expect(resolveRemoteSlotUnits({policy,kind,telemetry:null})).toEqual({units:1,source:'default'});
  });
  it('an elastic kind still refuses unreadable telemetry',()=>{
    expect(()=>resolveRemoteSlotUnits({policy,kind:'FULL',telemetry:null})).toThrow('Unreadable run count');
  });
});
