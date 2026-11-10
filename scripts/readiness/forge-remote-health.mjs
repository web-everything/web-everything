// Host-shared health/cache state. Missing state is a cold start; malformed state
// is an operator-visible local fallback, never permission to dispatch remotely.
import {readFileSync, writeFileSync, renameSync, rmSync, lstatSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {reserve, readLockEntry, releaseLockDir} from './file-locks.mjs';
import {parseTelemetry} from './forge-exec-run.mjs';
import {readForgeTelemetry, pingForge} from './forge-telemetry.mjs';

const freshState=()=>({v:1,lastReadAt:null,telemetry:null,failures:0,backoffUntil:0,trigger:''});
const integer=v=>Number.isSafeInteger(v)&&v>=0;
function readState(file) {
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
    if(error.code==='ENOENT')return freshState();
    const e=new Error('remote-health-unreadable');e.detail=String(error.message||error).slice(0,200);
    // Circuit-breaker evidence survives only when each field is individually valid; telemetry and any
    // lastGood* data are never carried over.
    if(parsed&&typeof parsed==='object')e.salvage={
      failures:integer(parsed.failures)?parsed.failures:0,backoffUntil:integer(parsed.backoffUntil)?parsed.backoffUntil:0,
      trigger:typeof parsed.trigger==='string'&&/^[a-zA-Z0-9.-]{0,80}$/.test(parsed.trigger)?parsed.trigger:''};
    throw e;
  }
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
async function transaction(root,action,host='forge') {
  const key=host==='forge'?'health':'health-'+createHash('sha256').update(host).digest('hex');
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
  const file=join(root,key+'.json'),pending=file+'-'+randomBytes(8).toString('hex');
  try {
    let state;
    try{state=readState(file);}
    catch(error){
      if(error.message!=='remote-health-unreadable')throw error;
      try{quarantine(root,key,file,error.detail);}
      catch(qe){const e=new Error('remote-health-unreadable');e.detail=`${error.detail}; quarantine failed: ${qe.message}`.slice(0,300);throw e;}
      state={...freshState(),...error.salvage};
    }
    const result=await action(state);
    writeFileSync(pending,JSON.stringify(state),{flag:'wx',mode:0o600});renameSync(pending,file);
    return result;
  } finally {rmSync(pending,{force:true});releaseLockDir(root,key);}
}
export async function checkRemoteHealth({root,settings,clock=Date.now,readTelemetry=readForgeTelemetry,host='forge',ping=pingForge}) {
  try{return await transaction(root,async state=>{
    const now=clock();
    if(now<state.backoffUntil)return {ok:false,reason:`backoff-${state.trigger}`};
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
    if(trigger){state.trigger=trigger;state.backoffUntil=clock()+settings.backoffMs;return {ok:false,reason:trigger};}
    return {ok:true};
  },host);}catch(error){
    if(error.message==='remote-health-busy')return {ok:false,reason:error.message};
    return {ok:false,reason:'remote-health-unreadable',detail:error.detail||String(error.message||error).slice(0,200)};
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
      if(state.failures>=settings.backoffFailures){state.backoffUntil=clock()+settings.backoffMs;state.trigger=reason;}
    } else state.failures=0;
  },host);
}

/** Latest persisted Forge telemetry sample (read-only; null when absent or unreadable). */
export function peekRemoteTelemetry({root,host='forge'}) {
  const key=host==='forge'?'health':'health-'+createHash('sha256').update(host).digest('hex');
  try{return readState(join(root,key+'.json')).telemetry;}catch{return null;}
}
