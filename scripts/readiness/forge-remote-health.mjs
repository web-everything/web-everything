// Host-shared health/cache state. Missing state is a cold start; malformed state
// is an operator-visible local fallback, never permission to dispatch remotely.
import {readFileSync, writeFileSync, renameSync, rmSync, lstatSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {reserve, readLockEntry, releaseLockDir} from './file-locks.mjs';
import {parseTelemetry} from './forge-exec-run.mjs';
import {readForgeTelemetry, pingForge} from './forge-telemetry.mjs';

const STATE_GENERATION='g2';
const stateKey=host=>'health-'+STATE_GENERATION+(host==='forge'?'':'-'+createHash('sha256').update(host).digest('hex'));
export const remoteHealthFile=(root,host='forge')=>join(root,stateKey(host)+'.json');
const freshState=()=>({v:1,lastReadAt:null,telemetry:null,failures:0,backoffUntil:0,trigger:''});
const integer=v=>Number.isSafeInteger(v)&&v>=0;
function readState(file,onMissing=freshState) {
  let parsed=null;
  try {
    const st=lstatSync(file);
    if(!st.isFile() || st.isSymbolicLink() || st.size>70000)throw new Error('invalid state size');
    const s=parsed=JSON.parse(readFileSync(file,'utf8'));
    if(!s || Object.keys(s).sort().join(',')!=='backoffUntil,failures,lastReadAt,telemetry,trigger,v' || s.v!==1
      || !(s.lastReadAt===null||integer(s.lastReadAt)) || !integer(s.failures) || !integer(s.backoffUntil)
      || typeof s.trigger!=='string' || !/^[a-zA-Z0-9.-]{0,80}$/.test(s.trigger))throw new Error('invalid state');
    if(s.telemetry!==null)parseTelemetry(JSON.stringify(s.telemetry));
    return s;
  } catch(error){
    if(error.code==='ENOENT')return onMissing();
    const e=new Error('remote-health-unreadable');e.detail=String(error.message||error).slice(0,200);
    // Circuit-breaker evidence survives only when each field is individually valid; telemetry and any
    // lastGood* data are never carried over.
    if(parsed&&typeof parsed==='object')e.salvage={
      failures:integer(parsed.failures)?parsed.failures:0,backoffUntil:integer(parsed.backoffUntil)?parsed.backoffUntil:0,
      trigger:typeof parsed.trigger==='string'&&/^[a-zA-Z0-9.-]{0,80}$/.test(parsed.trigger)?parsed.trigger:''};
    throw e;
  }
}
// Legacy state is read-only: retain individually valid breaker fields, never telemetry or cache metadata.
function seedLegacyBackoff(root,host) {
  const state=freshState();
  const file=join(root,'health'+(host==='forge'?'':'-'+createHash('sha256').update(host).digest('hex'))+'.json');
  try {
    const st=lstatSync(file);
    if(!st.isFile() || st.isSymbolicLink() || st.size>70000)return state;
    const parsed=JSON.parse(readFileSync(file,'utf8'));
    if(parsed&&typeof parsed==='object') {
      state.failures=integer(parsed.failures)?parsed.failures:0;
      state.backoffUntil=integer(parsed.backoffUntil)?parsed.backoffUntil:0;
      state.trigger=typeof parsed.trigger==='string'&&/^[a-zA-Z0-9.-]{0,80}$/.test(parsed.trigger)?parsed.trigger:'';
    }
  } catch {} // Missing, unreadable or malformed legacy evidence is ignored without mutation or logging.
  return state;
}
// A malformed state file can never repair itself (the write path needs a readable state), so it is moved aside,
// never deleted or followed, and the run continues from a fresh state: that forces a new telemetry read which must
// still pass every freshness, skew, load and RAM check. Only the newest few quarantined files are kept.
const KEEP_INVALID=3;
function quarantine(root,key,file,detail) {
  const prefix=key+'.json.invalid-';
  renameSync(file,join(root,prefix+new Date().toISOString()));
  const old=readdirSync(root).filter(n=>n.startsWith(prefix)).sort().slice(0,-KEEP_INVALID);
  for(const n of old)rmSync(join(root,n),{force:true});
  console.error(`forge-remote-health: quarantined malformed state ${key}.json (${detail}); continuing from fresh state`);
}
const UNREACHABLE_BACKOFF_MS=15000;
async function transaction(root,action,host='forge',onQuarantine=()=>{}) {
  const key=stateKey(host);
  const owner='remote-health-'+randomBytes(16).toString('hex'),start=Date.now();
  async function acquire() {
    const now=Date.now(),entry=readLockEntry(root,key);
    let liveness='unknown';
    if(Number.isInteger(entry?.pid)&&entry.pid!==process.pid)try{process.kill(entry.pid,0);}catch(error){if(error.code==='ESRCH')liveness='dead';}
    const lock=reserve(root,key,owner,now,new Date(now).toISOString(),process.pid,liveness,1,null,true);
    if(lock.ok)return;
    if(now-start>=10000)throw new Error('remote-health-busy');
    await new Promise(resolve=>setTimeout(resolve,50));return acquire();
  }
  await acquire();
  const file=remoteHealthFile(root,host),pending=file+'-'+randomBytes(8).toString('hex');
  try {
    let state;
    try{state=readState(file,()=>seedLegacyBackoff(root,host));}
    catch(error){
      if(error.message!=='remote-health-unreadable')throw error;
      try{quarantine(root,key,file,error.detail);}
      catch(qe){const e=new Error('remote-health-unreadable');e.detail=`${error.detail}; quarantine failed: ${qe.message}`.slice(0,300);throw e;}
      onQuarantine(`quarantined:${error.detail}`.slice(0,212));
      state={...freshState(),...error.salvage};
    }
    const result=await action(state);
    writeFileSync(pending,JSON.stringify(state),{flag:'wx',mode:0o600});renameSync(pending,file);
    return result;
  } finally {rmSync(pending,{force:true});releaseLockDir(root,key);}
}
export async function checkRemoteHealth({root,settings,clock=Date.now,readTelemetry=readForgeTelemetry,host='forge',ping=pingForge}) {
  let quarantineDetail='';
  const finish=result=>{
    if(result.ok)return result;
    const detail=quarantineDetail
      ? [result.detail?.slice(0,300-quarantineDetail.length-2),quarantineDetail].filter(Boolean).join('; ')
      : result.detail;
    return detail?{...result,detail:detail.slice(0,300)}:result;
  };
  try{return finish(await transaction(root,async state=>{
    const now=clock();
    let probeDetail='';
    if(now<state.backoffUntil){
      // A short unreachable backoff is lifted by the next good quick probe. Load/RAM/stale backoffs are never lifted this way.
      let lifted=false;
      if(state.trigger==='forge-unreachable'){try{lifted=(await ping({host}))===true;}catch{lifted=false;}}
      if(lifted){state.backoffUntil=0;state.lastReadAt=null;}
      else return state.trigger==='forge-unreachable'?{ok:false,reason:`backoff-${state.trigger}`,detail:`${state.backoffUntil-now}ms left`}:{ok:false,reason:`backoff-${state.trigger}`};
    }
    const stale=()=>{
      const age=clock()-Date.parse(state.telemetry?.sampledAtET);
      return !Number.isFinite(age)||age < -60000||age>30000;
    };
    // Cache failed reads as well as successful reads. The mutex covers the SSH
    // read so simultaneous clients cannot each poll Forge once per ten seconds.
    // Stale cached telemetry gets one refresh even inside the ten-second cache.
    if(state.lastReadAt===null || now-state.lastReadAt>=10000 || (state.telemetry && stale())) {
      state.lastReadAt=now;
      try{state.telemetry=parseTelemetry(JSON.stringify(await readTelemetry({host})));}
      catch(error){
        probeDetail=String(error?.detail||error?.message||error).slice(0,200);
        // A reachable host (quick ping) earns exactly ONE fresh re-read. The ping is never health evidence; the retry
        // still passes the freshness/skew and load/RAM checks below. No last-good sample is ever kept.
        state.telemetry=null;
        // Only a transport failure qualifies; malformed or invalid telemetry keeps today's fail-closed backoff.
        let reachable=false;
        try{reachable=error?.message==='forge-unreachable'&&error.transport===true&&(await ping({host}))===true;}catch{reachable=false;}
        if(reachable){
          try{state.telemetry=parseTelemetry(JSON.stringify(await readTelemetry({host})));}
          catch{state.telemetry=null;}
        }
      }
    }
    let trigger;
    if(!state.telemetry)trigger='forge-unreachable';
    else if(stale())trigger='telemetry-stale';
    else if(state.telemetry.loadPerCore>settings.maxLoadPerCore)trigger='maxLoadPerCore';
    else if(state.telemetry.memFreePct<settings.minFreeRamPct)trigger='minFreeRamPct';
    if(trigger){
      // A failed read is often one transient ssh drop, not an outage: keep that backoff short (the next good probe lifts it).
      if(trigger==='forge-unreachable')state.failures=state.trigger==='forge-unreachable'?Math.min(30,state.failures+1):1;
      // Repeated failures grow 15s,30s,60s... up to the full backoff, so a truly down Forge is not probed in a storm.
      state.backoffUntil=clock()+(trigger==='forge-unreachable'?Math.min(settings.backoffMs,UNREACHABLE_BACKOFF_MS*2**(state.failures-1)):settings.backoffMs);
      state.trigger=trigger;
      return probeDetail&&trigger==='forge-unreachable'?{ok:false,reason:trigger,detail:probeDetail}:{ok:false,reason:trigger};
    }
    if(state.trigger==='forge-unreachable'){state.trigger='';state.failures=0;}
    return {ok:true};
  },host,detail=>{quarantineDetail=detail;}));}catch(error){
    if(error.message==='remote-health-busy')return finish({ok:false,reason:error.message});
    return finish({ok:false,reason:'remote-health-unreadable',detail:error.detail||String(error.message||error).slice(0,200)});
  }
}
export async function recordRemoteResult({root,settings,clock=Date.now,result,host='forge'}) {
  return transaction(root,state=>{
    if(result?.mode==='remote'&&Number.isInteger(result.code)&&result.code>=0&&result.code<=254){
      state.failures=0;state.backoffUntil=0;state.trigger='';return;
    }
    const confirmed=(result?.mode==='not-started'||result?.mode==='cancelled')&&result.terminated===true;
    const reason=!confirmed?'unconfirmed':result.reason;
    if(['unconfirmed','forge-unreachable','copy-failed','forge-busy'].includes(reason)) {
      state.failures=Math.min(Number.MAX_SAFE_INTEGER,state.failures+1);
      if(state.failures>=settings.backoffFailures){const until=clock()+(reason==='forge-unreachable'?Math.min(settings.backoffMs,UNREACHABLE_BACKOFF_MS):settings.backoffMs);if(until>=state.backoffUntil){state.backoffUntil=until;state.trigger=reason;}}
    } else state.failures=0;
  },host);
}

/** Latest persisted Forge telemetry sample (read-only; null when absent or unreadable). */
export function peekRemoteTelemetry({root,host='forge'}) {
  try{return readState(remoteHealthFile(root,host)).telemetry;}catch{return null;}
}
