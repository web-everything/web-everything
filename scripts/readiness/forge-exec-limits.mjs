#!/usr/bin/env node
// Trusted operator configuration only; no request or environment config-path override.
import {constants, realpathSync} from 'node:fs';
import {open, rename, rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const DEFAULT_LIMITS = Object.freeze({
  parent:Object.freeze({cpuQuota:'2800%',memoryMax:'56G'}),
  slot:Object.freeze({cpuQuota:'800%',memoryMax:'12G',tasksMax:2048,ioWeight:100}),
  slots:Object.freeze({}),
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validators = {
  cpuQuota:value=>typeof value==='string' && /^[1-9]\d*%$/.test(value) && Number.isFinite(Number(value.slice(0,-1))),
  memoryMax:value=>typeof value==='string' && (value==='infinity'||/^[1-9]\d*[KMGT]?$/.test(value)),
  tasksMax:value=>value==='infinity'||Number.isInteger(value)&&value>=1&&value<=4194304,
  ioWeight:value=>Number.isInteger(value)&&value>=1&&value<=10000,
};
export function parseLimits(text) {
  const warnings=[];
  let data;
  try {data=JSON.parse(text);} catch {warnings.push('Invalid limits JSON; using defaults');}
  if(!object(data)) {warnings.push('Missing limits object; using defaults');data={};}
  const fields=(value,defaults,label,partial=false)=>{
    const result={};
    for(const [key,fallback] of Object.entries(defaults)) {
      if(partial && object(value) && !Object.hasOwn(value,key)) continue;
      if(object(value) && validators[key](value[key])) result[key]=value[key];
      else {warnings.push(label+'.'+key+': using default');result[key]=fallback;}
    }
    return result;
  };
  const limits={parent:fields(data.parent,DEFAULT_LIMITS.parent,'parent'),slot:fields(data.slot,DEFAULT_LIMITS.slot,'slot'),slots:{}};
  if(!object(data.slots)) warnings.push('slots: using empty overrides');
  else for(const [key,value] of Object.entries(data.slots)) {
    if(!/^[1-9]\d*$/.test(key)||!Number.isSafeInteger(Number(key))||!object(value)) {warnings.push('Invalid slot override: '+key);continue;}
    limits.slots[key]=fields(value,limits.slot,'slots.'+key,true);
  }
  return {limits,warnings};
}
function checkedSlot(slot) {
  if(!Number.isSafeInteger(slot)||slot<1) throw new Error('Invalid slot');
  return slot;
}
export function slotLimits(limits,k) {
  checkedSlot(k);
  return {...DEFAULT_LIMITS.slot,...limits.slot,...limits.slots?.[String(k)]};
}
export function slotCpus(limits,k) {return Math.max(1,Math.ceil(Number(slotLimits(limits,k).cpuQuota.slice(0,-1))/100));}
const accounting='CPUAccounting=yes\nMemoryAccounting=yes\nIOAccounting=yes\nTasksAccounting=yes\n';
export function renderParentSlice(limits) {
  const parent={...DEFAULT_LIMITS.parent,...limits.parent};
  return '[Unit]\nDescription=Forge exec aggregate ceiling\n\n[Slice]\n'+accounting+'CPUQuota='+parent.cpuQuota+'\nMemoryMax='+parent.memoryMax+'\n';
}
export function renderSlotSlice(limits,k) {
  const slot=slotLimits(limits,k);
  // systemd dash hierarchy nests forge-exec-K.slice under forge-exec.slice.
  return '[Unit]\nDescription=Forge exec slot '+k+'\n\n[Slice]\n'+accounting+'CPUQuota='+slot.cpuQuota+'\nMemoryMax='+slot.memoryMax+'\nMemorySwapMax=0\nTasksMax='+slot.tasksMax+'\nIOWeight='+slot.ioWeight+'\n';
}
export function setPropertyArgv(limits,slots) {
  const parent={...DEFAULT_LIMITS.parent,...limits.parent};
  return [
    ['set-property','forge-exec.slice','CPUQuota='+parent.cpuQuota,'MemoryMax='+parent.memoryMax],
    ...slots.map(k=>{const s=slotLimits(limits,k);return ['set-property','forge-exec-'+k+'.slice','CPUQuota='+s.cpuQuota,'MemoryMax='+s.memoryMax,'MemorySwapMax=0','TasksMax='+s.tasksMax,'IOWeight='+s.ioWeight];}),
  ];
}
export function scopeLauncherArgv({slot,unit,source,json,sudo=true}) {
  checkedSlot(slot);
  if(typeof unit!=='string'||!/^forge-exec-run-[a-f0-9]{16,}$/.test(unit)) throw new Error('Invalid scope unit');
  if(typeof source!=='string'||typeof json!=='string') throw new Error('Invalid supervisor arguments');
  // Never --uid: the root supervisor must retain its lease and drop identity
  // itself in preexec. The slot slice caps it and every descendant.
  return [...(sudo?['/usr/bin/sudo','-n']:[]),'/usr/bin/systemd-run','--scope','--quiet','--collect','--slice=forge-exec-'+slot+'.slice','--unit='+unit,'--','/usr/bin/python3','-I','-c',source,json];
}
export async function readLimits({testConfigPath}={}) {
  let fd;
  try {
    fd=await open(testConfigPath??'/etc/forge-exec/limits.json',constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st=await fd.stat();
    if(!st.isFile()||st.size>65536||(!testConfigPath&&(st.uid!==0||(st.mode&0o022)))) throw new Error('Untrusted or oversized limits file');
    return parseLimits(await fd.readFile('utf8'));
  } catch(error) {
    const result=parseLimits('{}');
    result.warnings.unshift('Cannot read limits; using defaults: '+error.message);
    return result;
  } finally {await fd?.close();}
}
function systemctl(args) {
  const result=spawnSync('/usr/bin/systemctl',args,{stdio:'inherit',env:{PATH:'/usr/bin:/bin'},timeout:30000});
  if(result.error||result.status!==0) throw new Error('systemctl failed: '+args[0]);
}
export async function applyLimits({testConfigPath}={}) {
  if(process.getuid()!==0) throw new Error('limits apply requires root');
  const {limits,warnings}=await readLimits({testConfigPath});
  for(const warning of warnings) console.error('forge-exec-limits: '+warning.replace(/[\x00-\x1f\x7f]/g,' '));
  let count=Number(process.env.FORGE_EXEC_SLOTS);
  if(process.env.FORGE_EXEC_SLOTS===undefined) {
    const users=spawnSync('/usr/bin/getent',['passwd'],{encoding:'utf8',maxBuffer:1024*1024,timeout:10000});
    if(users.error||users.status!==0) throw new Error('Cannot enumerate slot users');
    count=users.stdout.split('\n').filter(line=>/^forge-exec-[1-9]\d*:/.test(line)).length;
  }
  if(!Number.isInteger(count)||count<1||count>128) throw new Error('FORGE_EXEC_SLOTS must be 1..128');
  const slots=Array.from({length:count},(_,i)=>i+1);
  for(const [name,text] of [['forge-exec.slice',renderParentSlice(limits)],...slots.map(k=>['forge-exec-'+k+'.slice',renderSlotSlice(limits,k)])]) {
    const target='/etc/systemd/system/'+name,pending=target+'.'+randomBytes(16).toString('hex');
    try {
      const fd=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {await fd.writeFile(text);await fd.chown(0,0);await fd.chmod(0o644);await fd.sync();} finally {await fd.close();}
      await rename(pending,target);
    } finally {await rm(pending,{force:true});}
  }
  systemctl(['daemon-reload']);
  for(const args of setPropertyArgv(limits,slots)) systemctl(args);
}
const limitsCliPath=(()=>{try{return realpathSync(process.argv[1]);}catch{return '';}})();
if(process.argv[1] && limitsCliPath===realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if(process.argv.length!==3||process.argv[2]!=='apply') throw new Error('Expected apply');
    await applyLimits();
  } catch(error) {console.error('forge-exec-limits: '+String(error.message).replace(/[\x00-\x1f\x7f]/g,' '));process.exitCode=1;}
}
