#!/usr/bin/env node
import {appendFileSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {admissionLockRoot,loadAdmissionPolicy,runWithRemoteDecision} from './heavy-admission.mjs';
const TRIGGERS=new Set(['on-demand','breaker-half-open','forge-setup','overlay-adopt']);
export const CANARY_ARGV=Object.freeze(['npx','vitest','run','scripts/readiness/__tests__/forge-canary-fixture.test.mjs']);

/** A canary uses normal health, slot reservation and persistent execution markers, with no local rerun.
 * The half-open claimant alone bypasses backoff; telemetry must still pass. The canary intent marker
 * also prevents another canary using a different free slot while termination remains unconfirmed.
 * An abandoned intent requires operator confirmation of termination before removal. */
export async function runForgeCanary({cwd=process.cwd(),lockRoot=admissionLockRoot(cwd),host='forge',
  trigger='on-demand',clock=Date.now,runner,timeoutMs=120000,policy,readTelemetry}={}) {
  if(!TRIGGERS.has(trigger))throw new Error('invalid canary trigger');
  const start=clock(),remoteRoot=join(dirname(lockRoot),'remote');
  mkdirSync(remoteRoot,{recursive:true});
  const intent=join(remoteRoot,'canary.unconfirmed');
  let result,claimed=false,confirmed=false;
  try {
    try {writeFileSync(intent,JSON.stringify({pid:process.pid,at:start})+'\n',{flag:'wx',mode:0o600});claimed=true;}
    catch {throw Object.assign(new Error('canary termination unconfirmed'),{code:'canary-unconfirmed'});}
    const resolved=policy ?? loadAdmissionPolicy({repoRoot:cwd,checkoutRoot:cwd,env:{}});
    // An explicit operator probe selects remote routing; all resource and health limits remain in force.
    const canaryPolicy={...resolved,settings:{...resolved.settings,remote:{...resolved.settings.remote,enabled:true,mode:'always'}}};
    let refusal,observed;
    const admission=await runWithRemoteDecision({argv:[...CANARY_ARGV],cwd,lockRoot,host,clock,env:{},
      policy:canaryPolicy,readTelemetry,timeoutMs,remoteExec:runner,onRemoteResult:result=>{observed=result;},
      recoveryProbe:trigger==='breaker-half-open',
      log:line=>{refusal=line;}});
    confirmed=admission.handled===false
      || (observed?.mode==='remote' && Number.isInteger(observed.code) && observed.code>=0 && observed.code<=254)
      || (['not-started','cancelled'].includes(observed?.mode) && observed.terminated===true);
    result=admission.remoteResult ?? (observed?.reason==='remote-timeout'?{reason:'canary-timeout'}:observed)
      ?? {reason:refusal ?? 'canary-admission-refused'};
  } catch(error){result={reason:error?.code ?? 'canary-runner-failed'};}
  finally {if(claimed && confirmed)unlinkSync(intent);}
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
