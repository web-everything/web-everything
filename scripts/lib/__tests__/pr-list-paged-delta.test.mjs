import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listOpenPrsPagedHydratedCompleteAsync as list, resolvePrListPaging } from '../pr-list-paged.mjs';
import { loadHeavyStore, saveHeavyStore } from '../heavy-cache.mjs';
const repo = 'owner/name', nowMs = Date.parse('2026-11-25T12:01:00Z');
const paging = {pageSize:20,pageRetries:0,heavyBackstopSeconds:3600,heavySettleSeconds:5};
const row = (number=1,extra={}) => ({number,headRefOid:'a'.repeat(40),baseRefOid:'b'.repeat(40),baseRefName:'main',
 updatedAt:'2026-11-25T12:00:00Z',labels:{totalCount:0,nodes:[]},...extra});
const heavy = {body:'body',files:[{path:'a.mjs'}]};
const page = rows => JSON.stringify({data:{repository:{pullRequests:{nodes:rows,totalCount:rows.length,pageInfo:{hasNextPage:false,endCursor:null}}}}});
async function pass(rows, extra={}) {
 const reads=[];
 const result=await list({repo,paging,heavyFields:['body','files'],nowMs,delta:{isCandidate:()=>false},
  exec:()=>page(rows),execAsync:async (_cmd,args)=>{reads.push(args); return {stdout:JSON.stringify({...rows.find(r=>r.number===Number(args[2])),...heavy})};},...extra});
 return {...result,reads};
}
describe('pr-list-paged-delta',()=>{
 it('a second pass in a NEW process reuses unchanged non-candidates from the store',async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR,'heavy-process-'));
  try {
   const first=await pass([row()]); saveHeavyStore({repo,dir,entries:first.store});
   const source=`import {loadHeavyStore} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/heavy-cache.mjs')).href)};
    import {listOpenPrsPagedHydratedCompleteAsync as list} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/pr-list-paged.mjs')).href)};
    const result=await list({repo:${JSON.stringify(repo)},paging:${JSON.stringify(paging)},heavyFields:['body','files'],nowMs:${nowMs+1000},
    delta:{isCandidate:()=>false},store:loadHeavyStore({repo:${JSON.stringify(repo)},dir:${JSON.stringify(dir)}}).entries,
    exec:()=>${JSON.stringify(page([row()]))},execAsync:async()=>{throw Error('unexpected read');}});
    console.log(JSON.stringify(result.stats));`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
   expect(child.status,child.stderr).toBe(0); expect(JSON.parse(child.stdout)).toMatchObject({fetched:0,reused:1});
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it('a ready candidate is always re-read',async()=>{
  const first=await pass([row()]); const second=await pass([row()],{store:first.store,delta:{isCandidate:()=>true}});
  expect(second.stats).toMatchObject({fetched:1,reused:0,candidates:1,byReason:{candidate:1}});
 });
 it.each([
  ['label change',{updatedAt:'2026-11-25T12:00:01Z'},'identity'],
  ['head moves',{headRefOid:'c'.repeat(40)},'identity'],
  ['base moves',{baseRefOid:'c'.repeat(40)},'base-only'],
  ['older updatedAt',{updatedAt:'2026-11-24T12:00:00Z'},'identity'],
  ['incomplete labels',{labels:{nodes:[],totalCount:1}},'labels'],
 ])('%s re-reads',async(_name,change,reason)=>{
  const first=await pass([row()]); const second=await pass([row(1,change)],{store:first.store});
  expect(second.stats.byReason[reason]).toBe(1); expect(second.reads).toHaveLength(1);
 });
 it('missing backstop re-reads',async()=>{
  const first=await pass([row()]); const second=await pass([row()],{store:first.store,paging:{pageSize:20,pageRetries:0,heavySettleSeconds:5}});
  expect(second.stats.byReason.bounds).toBe(1);
 });
 it('gate fields come from the live page, never the store',async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR,'heavy-gates-'));
  try {
   const first=await pass([row()]); saveHeavyStore({repo,dir,entries:first.store});
   const path=join(dir,'heavy-owner-name.json'), data=JSON.parse(readFileSync(path,'utf8'));
   data.entries[0].statusCheckRollup=[{conclusion:'SUCCESS'}]; data.entries[0].mergeable='MERGEABLE';
   writeFileSync(path,JSON.stringify(data));
   const second=await pass([row(1,{mergeable:'CONFLICTING',reviewDecision:'CHANGES_REQUESTED'})],{store:loadHeavyStore({repo,dir}).entries});
   expect(second.rows[0]).toMatchObject({mergeable:'CONFLICTING',reviewDecision:'CHANGES_REQUESTED',statusCheckRollup:[]});
   expect(second.stats.reused).toBe(1);
   second.rows[0].files[0].path='mutable'; expect(second.store.get(1).files[0].path).toBe('a.mjs');
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it.each(['moved','failed'])('one %s read among six joins the pool, leaves store and disk unchanged',async(kind)=>{
  const dir=mkdtempSync(join(process.env.TMPDIR,'heavy-failure-'));
  try {
   const rows=Array.from({length:6},(_,i)=>row(i+1)), first=await pass(rows);
   saveHeavyStore({repo,dir,entries:first.store}); const path=join(dir,'heavy-owner-name.json'), before=readFileSync(path,'utf8');
   let finished=0;
   await expect(pass(rows,{store:first.store,delta:{isCandidate:()=>true},execAsync:async(_cmd,args)=>{
    await new Promise(resolve=>setImmediate(resolve)); finished++;
    const r=rows.find(r=>r.number===Number(args[2]));
    if(r.number===1 && kind==='failed') throw Error('fixture failure');
    return {stdout:JSON.stringify({...r,...heavy,...(r.number===1?{headRefOid:'f'.repeat(40)}:{})})};
   }})).rejects.toMatchObject({stage:'hydrate',cause:expect.any(Error)});
   expect(finished).toBe(6); expect(readFileSync(path,'utf8')).toBe(before); expect(first.store.size).toBe(6);
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it('reads at most six rows concurrently and joins all thirteen reads',async()=>{
  const rows=Array.from({length:13},(_,i)=>row(i+1));
  let active=0, peak=0, finished=0;
  const result=await pass(rows,{execAsync:async(_cmd,args)=>{
   active++; peak=Math.max(peak,active);
   await new Promise(resolve=>setImmediate(resolve));
   active--; finished++;
   return {stdout:JSON.stringify({...rows.find(r=>r.number===Number(args[2])),...heavy})};
  }});
  expect(peak).toBe(6); expect(finished).toBe(13); expect(result.store.size).toBe(13);
 });
 it('closed PRs are pruned and reopened ones re-read',async()=>{
  const first=await pass([row(),row(2)]), closed=await pass([row()],{store:first.store});
  expect([...closed.store.keys()]).toEqual([1]);
  const reopened=await pass([row(),row(2)],{store:closed.store}); expect(reopened.stats).toMatchObject({fetched:1,reused:1});
 });
 it.each([{seed:[row()]},{maxAgeMs:undefined},{maxAgeMs:1000},{heavyFields:['comments']},{heavyFields:['body']}])('delta rejects incompatible options %j',async(extra)=>{
  await expect(pass([row()],extra)).rejects.toThrow(TypeError);
 });
 it('delta requires a candidacy function',async()=>{await expect(pass([row()],{delta:{}})).rejects.toThrow(TypeError);});
 it('legacy path keeps its existing row/cache result',async()=>{
  const r=row(), result=await pass([r],{delta:undefined,paging:{pageSize:20,pageRetries:0,heavyMaxAgeSeconds:600}});
  expect(result.hydrated).toBe(1); expect(result.reused).toBe(0);
  expect(result.cache[1]).toEqual({updatedAt:r.updatedAt,headRefOid:r.headRefOid,fetchedAtMs:nowMs,...heavy});
  expect(result.stats).toBeUndefined(); expect(result.rows[0].body).toBe(heavy.body);
 });
 it('bounds validators accept endpoints, reject wrong types and report sources',()=>{
  for(const [key,values] of Object.entries({heavyBackstopSeconds:[0,604800],heavySettleSeconds:[1,300]})) {
   for(const value of values) {const r=resolvePrListPaging({env:{},file:{prListPaging:{[key]:value}}}); expect(r[key]).toBe(value); expect(r.source[key]).toBe('tool');}
   for(const value of [-1,1.5,'5',NaN,key==='heavySettleSeconds'?301:604801]) expect(resolvePrListPaging({env:{},file:{prListPaging:{[key]:value}}})[key]).toBeUndefined();
  }
 });
});
