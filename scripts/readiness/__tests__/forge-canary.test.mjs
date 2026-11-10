// @vitest-environment node
import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {runForgeCanary,CANARY_ARGV} from '../forge-canary.mjs';
import {allowedCommand,executionArgv} from '../forge-exec-run.mjs';
import {lockDirFor} from '../file-locks.mjs';
import {resolveAdmissionPolicy} from '../heavy-admission.mjs';
import {easternTimestamp} from '../forge-exec-run.mjs';
import {verifyReceipt} from '../remote-exec.mjs';
const roots=[];
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function root(){const r=mkdtempSync(join(process.env.TMPDIR,'canary-'));roots.push(r);return join(r,'heavy');}
const policy=resolveAdmissionPolicy({platform:{remote:{enabled:true,mode:'always',maxConcurrent:2}}});
const readTelemetry=async()=>({sampledAtET:easternTimestamp(1000),cores:8,loadPerCore:0.1,memFreePct:90,activeRuns:0,recent:[]});
const canary=opts=>runForgeCanary({policy,readTelemetry,clock:()=>1000,...opts});
it.each(['pass','fail'])('records a %s event using an injected runner without credentials',async result=>{
  const lockRoot=root(),runner=vi.fn(async()=>({mode:'remote',code:result==='pass'?0:1}));
  const event=await canary({lockRoot,runner,trigger:'overlay-adopt',clock:()=>1000});
  expect(event).toMatchObject({ts:new Date(1000).toISOString(),result,ms:0,trigger:'overlay-adopt'});
  expect(JSON.parse(readFileSync(join(lockRoot,'forge-canary.jsonl'),'utf8'))).toEqual(event);
  expect(runner.mock.calls[0][0]).toMatchObject({argv:CANARY_ARGV,env:{}});
});
it('records thrown transport errors and rejects invalid triggers',async()=>{
  const lockRoot=root();
  expect(await canary({lockRoot,runner:async()=>{throw Object.assign(new Error(),{code:'ENOENT'});}})).toMatchObject({result:'fail',reason:'ENOENT'});
  await expect(runForgeCanary({lockRoot,trigger:'bogus'})).rejects.toThrow('invalid canary trigger');
});
it('uses the existing Vitest command class without a canary-specific runner exception',()=>{
  expect(CANARY_ARGV).toEqual(['npx','vitest','run','scripts/readiness/__tests__/forge-canary-fixture.test.mjs']);
  expect(allowedCommand(CANARY_ARGV)).toBe(true);
  expect(executionArgv(CANARY_ARGV)).toEqual(['node','node_modules/vitest/vitest.mjs','run',CANARY_ARGV[3]]);
  expect(allowedCommand(['node','--test','scripts/readiness/fixtures/forge-canary.node.mjs'])).toBe(false);
  expect(allowedCommand(['node','--test','arbitrary.mjs'])).toBe(false);
  expect(allowedCommand([...CANARY_ARGV,'--eval=code'])).toBe(false);
});

it('bounds a stalled runner and records the timeout as a failed event',async()=>{
 const lockRoot=root();const event=await canary({lockRoot,runner:()=>new Promise(()=>{}),timeoutMs:1});
 expect(event).toMatchObject({result:'fail',reason:'canary-timeout'});
});
it('recognizes only a verified install-97 receipt as infrastructure completion',()=>{
 const expected={v:1,nonce:'nonce',run:'run',inputDigest:'input',argvDigest:'argv',lock:'lock',manifestDigest:'a'.repeat(64)};
 const receipt={...expected,phase:'install',code:97};
 expect(verifyReceipt(JSON.stringify(receipt),expected,97)).toBe(true);
 expect(verifyReceipt(JSON.stringify({...receipt,code:1}),expected,1)).toBe(false);
 expect(verifyReceipt(JSON.stringify({...receipt,nonce:'wrong'}),expected,97)).toBe(false);
});

it('reserves a slot and writes execution intent before dispatch; releases only on confirmed completion',async()=>{
 const lockRoot=root(),remote=join(dirname(lockRoot),'remote');
 const runner=vi.fn(async()=>{
  expect(existsSync(join(remote,'slot-0.unconfirmed'))).toBe(true);
  expect(existsSync(join(lockDirFor(remote,'slot-0'),'lock.json'))).toBe(true);
  return {mode:'remote',code:0};
 });
 expect(await canary({lockRoot,runner})).toMatchObject({result:'pass'});
 expect(runner).toHaveBeenCalledOnce();
 expect(existsSync(join(remote,'slot-0.unconfirmed'))).toBe(false);
 expect(existsSync(join(remote,'canary.unconfirmed'))).toBe(false);
});
it('retains timed-out execution markers and refuses another canary even with a free slot',async()=>{
 const lockRoot=root(),runner=vi.fn(()=>new Promise(()=>{}));
 expect(await canary({lockRoot,runner,timeoutMs:1})).toMatchObject({result:'fail'});
 expect(existsSync(join(dirname(lockRoot),'remote','slot-0.unconfirmed'))).toBe(true);
 expect(await canary({lockRoot,runner})).toMatchObject({result:'fail',reason:'canary-unconfirmed'});
 expect(runner).toHaveBeenCalledOnce();
});
it('refuses dispatch on failed health',async()=>{
 const lockRoot=root(),runner=vi.fn();
 expect(await canary({lockRoot,runner,readTelemetry:async()=>{throw new Error('invalid');}})).toMatchObject({result:'fail'});
 expect(runner).not.toHaveBeenCalled();
});

it('honours an outstanding normal run marker and uses a different available slot',async()=>{
 const lockRoot=root(),remote=join(dirname(lockRoot),'remote');mkdirSync(remote,{recursive:true});
 writeFileSync(join(remote,'slot-0.unconfirmed'),'unconfirmed normal execution\n');
 const runner=vi.fn(async()=>{
  expect(existsSync(join(remote,'slot-1.unconfirmed'))).toBe(true);
  return {mode:'remote',code:0};
 });
 expect(await canary({lockRoot,runner})).toMatchObject({result:'pass'});
 expect(runner).toHaveBeenCalledOnce();
 expect(existsSync(join(remote,'slot-0.unconfirmed'))).toBe(true);
});
it('refuses an unclaimed half-open probe without dispatch',async()=>{
 const runner=vi.fn();
 expect(await canary({lockRoot:root(),runner,trigger:'breaker-half-open'})).toMatchObject({result:'fail'});
 expect(runner).not.toHaveBeenCalled();
});
it('releases canary intent for a validated remote test exit of 124',async()=>{
 const lockRoot=root();
 expect(await canary({lockRoot,runner:async()=>({mode:'remote',code:124})})).toMatchObject({result:'fail',reason:'remote-exit-124'});
 expect(existsSync(join(dirname(lockRoot),'remote','canary.unconfirmed'))).toBe(false);
});
