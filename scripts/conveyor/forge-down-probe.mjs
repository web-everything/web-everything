/** Bounded, read-only outage evidence from the existing admission histories. */
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {readJsonlTail} from '../lib/forge-share.mjs';
import {admissionLockRoot,loadAdmissionPolicy} from '../readiness/heavy-admission.mjs';
import {isForgeInfraFailure} from '../readiness/forge-failure.mjs';

export function probeForgeDown({lockRoot,now=Date.now(),settings,sources={}}) {
  const from=now-3600000, outageFrom=now-Math.max(60,settings.forgeDownMinutes*2)*60000;
  const read=(name,key='ts',needFrom=outageFrom)=>readJsonlTail(join(lockRoot,name),r=>r[key],needFrom);
  const rem=read('remote-runs.jsonl'),fb=read('remote-fallbacks.jsonl'),local=read('durations.jsonl','at',from);
  const can=existsSync(join(lockRoot,'forge-canary.jsonl'))?read('forge-canary.jsonl','ts',from):null;
  const window=rows=>rows.filter(r=>Date.parse(r.ts ?? r.at)>=from && Date.parse(r.ts ?? r.at)<=now);
  const fallbacks=window(fb?.rows ?? []),remote=window(rem?.rows ?? []);
  const reasons=Object.create(null);
  for(const r of fallbacks)reasons[r.reason ?? 'unknown']=(reasons[r.reason ?? 'unknown'] ?? 0)+1;
  const topReason=Object.entries(reasons).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0] ?? 'none';
  const latestCanary=window(can?.rows ?? []).sort((a,b)=>Date.parse(b.ts)-Date.parse(a.ts))[0];
  const unknown=why=>({status:'unknown',breach:true,topReason,summary:`Forge evidence UNKNOWN (${why}); top fallback: ${topReason}.`,settings,sources});
  if([rem,fb,local].some(r=>!r || r.incomplete || (r.truncated&&!r.covered)))return unknown('missing, unreadable or incomplete admission history');
  if(can?.incomplete)return unknown('incomplete canary event');
  if(can && can.truncated&&!can.covered)return unknown('incomplete canary history');
  if(existsSync(join(lockRoot,'forge-canary.jsonl'))&&!can)return unknown('unreadable canary history');
  if(fallbacks.some(r=>typeof r.reason!=='string') || (can && window(can.rows).some(r=>!['pass','fail'].includes(r.result))))return unknown('invalid fallback or canary event');
  if(remote.some(r=>!Number.isFinite(r.ms)||r.ms<0)||window(local.rows).some(r=>!Number.isFinite(r.ms)||r.ms<0))return unknown('invalid duration');
  const successes=remote.filter(r=>r.code!==97 && !isForgeInfraFailure(r));
  const lastSuccess=Math.max(outageFrom,...rem.rows.filter(r=>Date.parse(r.ts)<=now && r.code!==97 && !isForgeInfraFailure(r)).map(r=>Date.parse(r.ts)));
  // Breaker refusals continue an outage without being new execution failures that increment the breaker.
  const outageFallback=r=>r.reason==='forge-breaker-open' || isForgeInfraFailure(r);
  const infra=fb.rows.filter(outageFallback).concat(rem.rows.filter(isForgeInfraFailure))
    .filter(r=>Date.parse(r.ts)>lastSuccess && Date.parse(r.ts)<=now).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  const span=infra.length>1?Date.parse(infra.at(-1).ts)-Date.parse(infra[0].ts):0;
  const remoteMs=successes.reduce((n,r)=>n+r.ms,0), localRows=window(local.rows),localMs=localRows.reduce((n,r)=>n+r.ms,0);
  const runs=successes.length+localRows.length,totalMs=remoteMs+localMs;
  const share=totalMs>0?remoteMs/totalMs:null;
  const outage=span>=settings.forgeDownMinutes*60000;
  const lowShare=runs>=settings.forgeDownMinRuns && share!==null && share<settings.forgeDownShare;
  const failedCanary=latestCanary?.result==='fail';
  return {status:'ok',breach:outage||lowShare||failedCanary,topReason,share,runs,span,settings,sources,
    summary:`Forge ${outage?'infrastructure outage':lowShare?'heavy-minute share low':failedCanary?'canary failed':'healthy'}; remote share ${share===null?'no volume':Math.round(share*100)+'%'}; top fallback: ${topReason}${failedCanary?`; canary failed (${latestCanary.reason})`:''}.`};
}
export function probeForgeDownForWatch({repoRoot,env=process.env,now=Date.now()}={}) {
  try {
    const policy=loadAdmissionPolicy({repoRoot,checkoutRoot:repoRoot,env});
    return probeForgeDown({lockRoot:admissionLockRoot(repoRoot,env),now,settings:policy.settings.remote,sources:policy.sources});
  } catch {return {status:'unknown',breach:true,summary:'Forge evidence UNKNOWN (probe failed); top fallback: unknown.'};}
}
export const forgeDownEventLine=probe=>probe?.breach?`FORGE-DOWN ${probe.summary}`:null;
