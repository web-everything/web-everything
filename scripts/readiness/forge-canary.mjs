#!/usr/bin/env node
import {appendFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {admissionLockRoot} from './heavy-admission.mjs';
const TRIGGERS=new Set(['on-demand','breaker-half-open','forge-setup','overlay-adopt']);
export const CANARY_ARGV=Object.freeze(['npx','vitest','run','scripts/readiness/__tests__/forge-canary-fixture.test.mjs']);

/** Direct Forge execution, never local fallback. Use the existing Vitest command class so installed runners need no refresh.
 * No AI credentials are supplied. The real transport retains its normal bundle scan and receipt validation. */
export async function runForgeCanary({cwd=process.cwd(),lockRoot=admissionLockRoot(cwd),host='forge',
  trigger='on-demand',clock=Date.now,runner,timeoutMs=120000}={}) {
  if(!TRIGGERS.has(trigger))throw new Error('invalid canary trigger');
  const start=clock();
  let result,timer;
  const controller=new AbortController();
  try {
    runner ??= (await import('./remote-exec.mjs')).runRemote;
    result=await Promise.race([
    Promise.resolve().then(()=>runner({argv:[...CANARY_ARGV],cwd,host,env:{},cancelSignal:controller.signal})),
    new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({reason:'canary-timeout'});},timeoutMs);}),
  ]);}
  catch(error){result={reason:error?.code ?? 'canary-runner-failed'};}
  finally {clearTimeout(timer);}
  const pass=result?.mode==='remote' && result.code===0;
  const reason=pass?'ok':String(result?.infraFailure ?? result?.reason ?? `remote-exit-${result?.code ?? 'unknown'}`)
    .replace(/[\x00-\x1f\x7f-\x9f]/g,'?').slice(0,200);
  const event={ts:new Date(clock()).toISOString(),result:pass?'pass':'fail',ms:Math.max(0,clock()-start),trigger,reason};
  mkdirSync(lockRoot,{recursive:true});
  appendFileSync(join(lockRoot,'forge-canary.jsonl'),JSON.stringify(event)+'\n');
  return event;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  try {
    if(args.some(a=>a!=='--json'&&!a.startsWith('--trigger=')))throw new Error('usage: forge-canary.mjs [--json] [--trigger=<trigger>]');
    const event=await runForgeCanary({trigger:args.find(a=>a.startsWith('--trigger='))?.slice(10) ?? 'on-demand'});
    console.log(args.includes('--json')?JSON.stringify(event):`Forge canary ${event.result}: ${event.reason}`);
    process.exitCode=event.result==='pass'?0:1;
  } catch(error){console.error(error.message);process.exitCode=1;}
}
