// @vitest-environment node
import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {runForgeCanary,CANARY_ARGV} from '../forge-canary.mjs';
import {allowedCommand,executionArgv} from '../forge-exec-run.mjs';
import {verifyReceipt} from '../remote-exec.mjs';
const roots=[];
afterEach(()=>roots.splice(0).forEach(r=>rmSync(r,{recursive:true,force:true})));
function root(){const r=mkdtempSync(join(process.env.TMPDIR,'canary-'));roots.push(r);return r;}
it.each(['pass','fail'])('records a %s event using an injected runner without credentials',async result=>{
  const lockRoot=root(),runner=vi.fn(async()=>({mode:'remote',code:result==='pass'?0:1}));
  const event=await runForgeCanary({lockRoot,runner,trigger:'overlay-adopt',clock:()=>1000});
  expect(event).toMatchObject({ts:new Date(1000).toISOString(),result,ms:0,trigger:'overlay-adopt'});
  expect(JSON.parse(readFileSync(join(lockRoot,'forge-canary.jsonl'),'utf8'))).toEqual(event);
  expect(runner.mock.calls[0][0]).toMatchObject({argv:CANARY_ARGV,env:{}});
});
it('records thrown transport errors and rejects invalid triggers',async()=>{
  const lockRoot=root();
  expect(await runForgeCanary({lockRoot,runner:async()=>{throw Object.assign(new Error(),{code:'ENOENT'});}})).toMatchObject({result:'fail',reason:'ENOENT'});
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
 const lockRoot=root();const event=await runForgeCanary({lockRoot,runner:()=>new Promise(()=>{}),timeoutMs:1});
 expect(event).toMatchObject({result:'fail',reason:'canary-timeout'});
});
it('recognizes only a verified install-97 receipt as infrastructure completion',()=>{
 const expected={v:1,nonce:'nonce',run:'run',inputDigest:'input',argvDigest:'argv',lock:'lock',manifestDigest:'a'.repeat(64)};
 const receipt={...expected,phase:'install',code:97};
 expect(verifyReceipt(JSON.stringify(receipt),expected,97)).toBe(true);
 expect(verifyReceipt(JSON.stringify({...receipt,code:1}),expected,1)).toBe(false);
 expect(verifyReceipt(JSON.stringify({...receipt,nonce:'wrong'}),expected,97)).toBe(false);
});
