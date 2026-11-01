// Host-shared health/cache state. Missing state is a cold start; malformed state
// is an operator-visible local fallback, never permission to dispatch remotely.
import {readFileSync, writeFileSync, renameSync, rmSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes, createHash} from 'node:crypto';
import {reserve, readLockEntry, releaseLockDir} from './file-locks.mjs';
import {parseTelemetry} from './forge-exec-run.mjs';
import {readForgeTelemetry} from './forge-telemetry.mjs';

const freshState=()=>({v:1,lastReadAt:null,telemetry:null,failures:0,backoffUntil:0,trigger:''});
const integer=v=>Number.isSafeInteger(v)&&v>=0;
function readState(file) {
  try {
    const st=lstatSync(file);
    if(!st.isFile() || st.isSymbolicLink() || st.size>70000)throw new Error('invalid state size');
    const s=JSON.parse(readFileSync(file,'utf8'));
    if(!s || Object.keys(s).sort().join(',')!=='backoffUntil,failures,lastReadAt,telemetry,trigger,v' || s.v!==1
      || !(s.lastReadAt===null||integer(s.lastReadAt)) || !integer(s.failures) || !integer(s.backoffUntil)
      || typeof s.trigger!=='string' || !/^[a-zA-Z0-9.-]{0,80}$/.test(s.trigger))throw new Error('invalid state');
    if(s.telemetry!==null)parseTelemetry(JSON.stringify(s.telemetry));
    return s;
  } catch(error){if(error.code==='ENOENT')return freshState();throw new Error('remote-health-unreadable');}
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
    const state=readState(file),result=await action(state);
    writeFileSync(pending,JSON.stringify(state),{flag:'wx',mode:0o600});renameSync(pending,file);
    return result;
  } finally {rmSync(pending,{force:true});releaseLockDir(root,key);}
}
export async function checkRemoteHealth({root,settings,clock=Date.now,readTelemetry=readForgeTelemetry,host='forge'}) {
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
      catch{state.telemetry=null;}
    }
    let trigger;
    if(!state.telemetry)trigger='forge-unreachable';
    else if(stale())trigger='telemetry-stale';
    else if(state.telemetry.loadPerCore>settings.maxLoadPerCore)trigger='maxLoadPerCore';
    else if(state.telemetry.memFreePct<settings.minFreeRamPct)trigger='minFreeRamPct';
    if(trigger){state.trigger=trigger;state.backoffUntil=clock()+settings.backoffMs;return {ok:false,reason:trigger};}
    return {ok:true,telemetry:state.telemetry};
  },host);}catch(error){return {ok:false,reason:error.message==='remote-health-busy'?error.message:'remote-health-unreadable'};}
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
