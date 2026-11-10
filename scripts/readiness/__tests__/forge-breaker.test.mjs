// @vitest-environment node
import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {checkForgeBreaker,recordRemoteResult,checkRemoteHealth} from '../forge-remote-health.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';
import {runWithRemoteDecision,resolveAdmissionPolicy,formatAdmissionPolicy} from '../heavy-admission.mjs';
const roots=[];
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function fixture(){const root=mkdtempSync(join(process.env.TMPDIR,'breaker-'));roots.push(root);let now=1000000;
  const settings={backoffFailures:3,backoffMs:600000};
  const opts={root,settings,clock:()=>now};
  return {root,settings,opts,advance:(ms=600001)=>{now+=ms;},state:()=>JSON.parse(readFileSync(join(root,'health.json'),'utf8'))};}
const infra={mode:'not-started',terminated:true,reason:'forge-unreachable'};
async function open(f){await recordRemoteResult({...f.opts,result:infra});await recordRemoteResult({...f.opts,result:infra});await recordRemoteResult({...f.opts,result:infra});}
it('closed -> open -> half-open -> closed; late results cannot reset an open breaker',async()=>{
  const f=fixture(),canary=vi.fn(async()=>({result:'pass'}));
  expect(await checkForgeBreaker({...f.opts,canary})).toEqual({ok:true});
  await open(f);
  await recordRemoteResult({...f.opts,result:{mode:'remote',code:0}});
  expect(await checkForgeBreaker({...f.opts,canary})).toMatchObject({reason:'forge-breaker-open'});
  expect(canary).not.toHaveBeenCalled();f.advance();
  expect(await checkForgeBreaker({...f.opts,canary:async()=>{
    expect(f.state().breakerPhase).toBe('half-open');return {result:'pass'};
  }})).toEqual({ok:true});expect(f.state()).toMatchObject({failures:0,backoffUntil:0,trigger:''});
});
it('uses nondefault policy backoffMs for opening and reopening deadlines and admission across expiry',async()=>{
  const f=fixture();f.settings.backoffMs=12345;
  const openedAt=f.opts.clock();
  await open(f);
  expect(f.state()).toMatchObject({breakerPhase:'open',breakerUntil:openedAt+12345});
  const canary=vi.fn(async()=>({result:'fail'}));
  f.advance(12344);
  expect(await checkForgeBreaker({...f.opts,canary})).toMatchObject({ok:false,reason:'forge-breaker-open'});
  expect(canary).not.toHaveBeenCalled();
  f.advance(2);
  expect(await checkForgeBreaker({...f.opts,canary})).toMatchObject({ok:false,reason:'forge-breaker-open'});
  expect(canary).toHaveBeenCalledTimes(1);
  expect(f.state()).toMatchObject({breakerPhase:'open',breakerUntil:f.opts.clock()+12345});
  canary.mockResolvedValue({result:'pass'});
  f.advance(12344);
  expect(await checkForgeBreaker({...f.opts,canary})).toMatchObject({ok:false,reason:'forge-breaker-open'});
  expect(canary).toHaveBeenCalledTimes(1);
  f.advance(2);
  expect(await checkForgeBreaker({...f.opts,canary})).toEqual({ok:true});
  expect(canary).toHaveBeenCalledTimes(2);
  expect(f.state()).toMatchObject({failures:0,backoffUntil:0,trigger:''});
});
it('admits exactly one half-open canary and reopens on its failure',async()=>{
  const f=fixture();await open(f);f.advance();
  let enter,finish;const entered=new Promise(r=>{enter=r;});
  const first=checkForgeBreaker({...f.opts,canary:()=>{enter();return new Promise(r=>{finish=r;});}});
  await entered;expect(f.state().breakerPhase).toBe('half-open');
  const second=vi.fn();expect(await checkForgeBreaker({...f.opts,canary:second})).toMatchObject({reason:'forge-breaker-open'});
  expect(second).not.toHaveBeenCalled();finish({result:'fail'});
  expect(await first).toMatchObject({reason:'forge-breaker-open'});expect(f.state().breakerUntil).toBeGreaterThan(f.opts.clock());
});
it.each([
  {mode:'not-started',terminated:true,reason:'forge-busy'},{mode:'unconfirmed'},
  {mode:'remote',code:1},{mode:'remote',code:97},{mode:'not-started',terminated:true,reason:'bundle-credential-hit',detail:'ENOENT'},
  {mode:'not-started',terminated:true,reason:'command-not-allowed',detail:'timeout'},
])('does not open on test failure or policy refusal: %j',async result=>{
  const f=fixture();for(let i=0;i<4;i++)await recordRemoteResult({...f.opts,result});
  expect(f.state()).toMatchObject({infraFailures:0,breakerUntil:0,breakerPhase:''});
});
it.each(['ENOENT','remote-timeout','ssh-error','transport-error','install-failed','copy-failed'])('opens on consecutive %s failures',async reason=>{
  const f=fixture();for(let i=0;i<3;i++)await recordRemoteResult({...f.opts,result:{...infra,reason}});
  expect(f.state().breakerPhase).toBe('open');
});
it('opens on verified install-97 evidence',async()=>{
  const f=fixture();for(let i=0;i<3;i++)await recordRemoteResult({...f.opts,result:{mode:'unconfirmed',reason:'ambiguous-result',infraFailure:'install-failed'}});
  expect(f.state().breakerPhase).toBe('open');
});
it('open breaker falls back locally with named history and zero remote dispatch',async()=>{
  const f=fixture();await open(f);const lockRoot=join(f.root,'heavy');mkdirSync(lockRoot);
  // Admission stores remote health alongside the heavy lock root.
  const remoteRoot=join(f.root,'remote');mkdirSync(remoteRoot);writeFileSync(join(remoteRoot,'health.json'),readFileSync(join(f.root,'health.json')));
  const remoteExec=vi.fn(),canaryRunner=vi.fn();
  const policy=resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always'}}});
  const result=await runWithRemoteDecision({argv:['npx','vitest','run','example.test.mjs'],cwd:f.root,lockRoot,policy,
    clock:f.opts.clock,loadPerCore:()=>10,remoteExec,canaryRunner,env:{},log:()=>{}});
  expect(result).toEqual({handled:false});expect(remoteExec).not.toHaveBeenCalled();expect(canaryRunner).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(lockRoot,'remote-fallbacks.jsonl'),'utf8')).reason).toBe('forge-breaker-open');
});
it('preserves breaker state and requires fresh health after oversized state quarantine',async()=>{
  const f=fixture();await open(f);const state=f.state();state.trigger='copy-failed';writeFileSync(join(f.root,'health.json'),JSON.stringify(state));
  expect(await checkForgeBreaker(f.opts)).toMatchObject({reason:'forge-breaker-open'});
  writeFileSync(join(f.root,'health.json'),'x'.repeat(80000));
  // Quarantine discards invalid state; telemetry admission still must obtain fresh evidence.
  expect(await checkForgeBreaker(f.opts)).toEqual({ok:true});
  expect(await checkRemoteHealth({...f.opts,readTelemetry:async()=>{throw new Error('forge-unreachable');},ping:async()=>false})).toMatchObject({ok:false,reason:'forge-unreachable'});
});
it('validates and logs new settings and changed backoff defaults with provenance',()=>{
 const p=resolveAdmissionPolicy({});expect(p.settings.remote).toMatchObject({backoffMs:600000,backoffFailures:3,forgeDownMinutes:15,forgeDownShare:0.3,forgeDownMinRuns:5});
 for(const key of ['forgeDownMinutes','forgeDownShare','forgeDownMinRuns']) {
  expect(formatAdmissionPolicy(p)).toContain(`remote.${key}=${p.settings.remote[key]} (standard)`);
  expect(resolveAdmissionPolicy({platform:{remote:{[key]:-1}}}).invalid).toContainEqual(expect.stringContaining(key));
 }
});

it.each(['pass','fail'])('admission half-open invokes and records the canary %s before any remote dispatch',async verdict=>{
 const f=fixture();await open(f);f.advance();
 const lockRoot=join(f.root,'heavy'),remoteRoot=join(f.root,'remote');mkdirSync(lockRoot);mkdirSync(remoteRoot);
 writeFileSync(join(remoteRoot,'health.json'),readFileSync(join(f.root,'health.json')));
 const remoteExec=vi.fn(async()=>({mode:'remote',code:0}));
 const canaryRunner=vi.fn(async()=>({mode:'remote',code:verdict==='pass'?0:97}));
 const readTelemetry=vi.fn(async()=>({sampledAtET:easternTimestamp(f.opts.clock()),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]}));
 const policy=resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',maxConcurrent:1}}});
 const result=await runWithRemoteDecision({argv:['npx','vitest','run','example.test.mjs'],cwd:f.root,lockRoot,policy,
  clock:f.opts.clock,loadPerCore:()=>10,remoteExec,canaryRunner,readTelemetry,env:{},log:()=>{}});
 expect(canaryRunner).toHaveBeenCalledTimes(1);
 expect(JSON.parse(readFileSync(join(lockRoot,'forge-canary.jsonl'),'utf8'))).toMatchObject({trigger:'breaker-half-open',result:verdict});
 if(verdict==='fail') {
  expect(result).toEqual({handled:false});expect(remoteExec).not.toHaveBeenCalled();expect(readTelemetry).toHaveBeenCalled();
  expect(JSON.parse(readFileSync(join(lockRoot,'remote-fallbacks.jsonl'),'utf8')).reason).toBe('forge-breaker-open');
 } else {expect(result).toMatchObject({handled:true,exitCode:0});expect(remoteExec).toHaveBeenCalledTimes(1);}
});

it('counts verified install receipt evidence while retaining the existing unconfirmed-run refusal',async()=>{
 const f=fixture();for(let i=0;i<3;i++)await recordRemoteResult({...f.opts,result:{mode:'unconfirmed',reason:'ambiguous-result',infraFailure:'install-failed'}});
 expect(f.state().breakerPhase).toBe('open');
});

it.each(['ENOENT','timeout'])('admission records and counts thrown or timed-out infrastructure evidence: %s',async kind=>{
 const f=fixture(),lockRoot=join(f.root,'heavy');mkdirSync(lockRoot);
 const policy=resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',backoffFailures:1}}});
 const remoteExec=vi.fn(kind==='ENOENT'?async()=>{throw Object.assign(new Error('missing ssh'),{code:'ENOENT'});}:()=>new Promise(()=>{}));
 const options={argv:['npx','vitest','run','example.test.mjs'],cwd:f.root,lockRoot,policy,
  clock:f.opts.clock,loadPerCore:()=>10,remoteExec,timeoutMs:1,env:{},log:()=>{},
  readTelemetry:async()=>({sampledAtET:easternTimestamp(f.opts.clock()),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]})};
 expect(await runWithRemoteDecision(options)).toMatchObject({handled:true,exitCode:124});
 expect(JSON.parse(readFileSync(join(lockRoot,'remote-fallbacks.jsonl'),'utf8')).reason).toBe(kind==='ENOENT'?'ENOENT':'remote-timeout');
 expect(await runWithRemoteDecision(options)).toEqual({handled:false});expect(remoteExec).toHaveBeenCalledTimes(1);
});

it.each([
  ['pass','before'],['pass','after'],['fail','before'],['fail','after'],
])('recovers an abandoned half-open lease with exactly one %s replacement; stale completion %s replacement cannot overwrite it',async (result,timing)=>{
  const f=fixture();await open(f);f.advance();
  let enterAbandoned,finishAbandoned;
  const abandonedEntered=new Promise(resolve=>{enterAbandoned=resolve;});
  const abandoned=checkForgeBreaker({...f.opts,canary:()=>{
    enterAbandoned();return new Promise(resolve=>{finishAbandoned=resolve;});
  }});
  await abandonedEntered;
  const abandonedLease=f.state().breakerUntil;
  expect(f.state().breakerPhase).toBe('half-open');

  // Leave the first canary unresolved, modeling a claimant that stopped making progress.
  f.advance(300001);
  expect(f.opts.clock()).toBeGreaterThan(abandonedLease);
  let enterReplacement,finishReplacement;
  const replacementEntered=new Promise(resolve=>{enterReplacement=resolve;});
  const replacementCanary=vi.fn(()=>{
    enterReplacement();return new Promise(resolve=>{finishReplacement=resolve;});
  });
  const replacement=checkForgeBreaker({...f.opts,canary:replacementCanary});
  await replacementEntered;
  const replacementState=f.state();
  expect(replacementState.breakerPhase).toBe('half-open');
  expect(replacementState.breakerUntil).toBe(f.opts.clock()+300000);
  expect(replacementState.breakerUntil).not.toBe(abandonedLease);
  const competingCanary=vi.fn();
  expect(await checkForgeBreaker({...f.opts,canary:competingCanary})).toEqual({ok:false,reason:'forge-breaker-open'});
  expect(competingCanary).not.toHaveBeenCalled();
  expect(replacementCanary).toHaveBeenCalledTimes(1);

  const settleStale=async()=>{
    finishAbandoned({result:result==='pass'?'fail':'pass'});
    expect(await abandoned).toEqual({ok:false,reason:'forge-breaker-open'});
  };
  if(timing==='before') {
    await settleStale();
    expect(f.state()).toEqual(replacementState);
  }
  finishReplacement({result});
  expect(await replacement).toEqual(result==='pass'?{ok:true}:{ok:false,reason:'forge-breaker-open'});
  const finalState=f.state();
  expect(finalState).toMatchObject(result==='pass'
    ? {breakerPhase:'',infraFailures:0,breakerUntil:0}
    : {breakerPhase:'open',breakerUntil:f.opts.clock()+f.settings.backoffMs});
  if(timing==='after')await settleStale();
  expect(f.state()).toEqual(finalState);
});

it.each([undefined,null,'0',NaN,Infinity,-1,255,0.5])('invalid remote exit %s increments legacy failures and retains backoff',async code=>{
 const f=fixture();
 const prior={v:1,lastReadAt:null,telemetry:null,failures:1,backoffUntil:2000000,trigger:'forge-busy'};
 writeFileSync(join(f.root,'health.json'),JSON.stringify(prior));
 await recordRemoteResult({...f.opts,result:{mode:'remote',code}});
 expect(f.state()).toMatchObject({failures:2,backoffUntil:prior.backoffUntil,trigger:'forge-busy',infraFailures:0});
});
it.each([0,1,97,254])('validated remote exit %s clears legacy accounting without closing the breaker',async code=>{
 const f=fixture();await open(f);
 await recordRemoteResult({...f.opts,result:{mode:'remote',code}});
 expect(f.state()).toMatchObject({failures:0,backoffUntil:0,trigger:'',breakerPhase:'open',infraFailures:3});
});
it('keeps legacy busy and ambiguous failures additive to an independent infrastructure streak',async()=>{
 const f=fixture();
 for(const result of [infra,{mode:'unconfirmed'},infra,{mode:'not-started',terminated:true,reason:'forge-busy'}])await recordRemoteResult({...f.opts,result});
 expect(f.state()).toMatchObject({failures:4,trigger:'forge-busy',infraFailures:0,breakerPhase:''});
 expect(await checkForgeBreaker(f.opts)).toEqual({ok:true});
});
it.each([{}, {lastGoodAt:1}])('migrates pre-separation breaker state without dropping its open deadline (extra fields %j)',async extra=>{
 const f=fixture();writeFileSync(join(f.root,'health.json'),JSON.stringify({v:1,lastReadAt:null,telemetry:null,failures:3,backoffUntil:2000000,trigger:'forge-breaker-open',...extra}));
 expect(await checkForgeBreaker(f.opts)).toMatchObject({reason:'forge-breaker-open'});
 expect(f.state()).toMatchObject({infraFailures:3,breakerUntil:2000000,breakerPhase:'open'});
});
