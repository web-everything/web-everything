import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listOpenPrsPagedHydratedCompleteAsync as list, resolvePrListPaging } from '../pr-list-paged.mjs';
import { loadBounds, loadHeavyStore, saveHeavyStore } from '../heavy-cache.mjs';
import { LISTED_FILES_CAP, listedPrFiles } from '../red-main-quarantine.mjs';
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
const storeFile = (dir, repo) => join(dir, `heavy-${createHash('sha256').update(repo.toLowerCase()).digest('hex')}.json`);
let snapshotDir;
beforeEach(() => {
 snapshotDir = mkdtempSync(join(process.env.TMPDIR, 'heavy-isolated-'));
 vi.stubEnv('WE_PR_SNAPSHOT_DIR', snapshotDir);
 vi.stubEnv('WE_PR_SNAPSHOT', '1');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(snapshotDir, {recursive:true,force:true}); });
describe('pr-list-paged-delta',()=>{
 it('a capped file list does not block healthy rows and is never reused',async()=>{
  const rows=[row(),row(2)], execAsync=vi.fn(async(_cmd,args)=>({stdout:JSON.stringify({
   ...rows.find(r=>r.number===Number(args[2])),...heavy,
   ...(Number(args[2])===1?{files:Array.from({length:LISTED_FILES_CAP},()=>({path:'large.mjs'}))}:{}),
  })}));
  const first=await pass(rows,{execAsync});
  expect(first.rows.map(r=>r.number)).toEqual([1,2]);
  expect(listedPrFiles(first.rows[0])).toBeNull();
  const second=await pass(rows,{execAsync,store:first.store});
  expect(second.rows.map(r=>r.number)).toEqual([1,2]);
  expect(second.stats).toMatchObject({fetched:1,reused:1});
 });
 it.each(['headRefOid','updatedAt'])('one moved %s among six is isolated without using stale evidence',async field=>{
  const rows=Array.from({length:6},(_,i)=>row(i+1)), first=await pass(rows);
  const result=await pass(rows,{store:first.store,delta:{isCandidate:()=>true},execAsync:async(_cmd,args)=>{
   const r=rows.find(r=>r.number===Number(args[2]));
   return {stdout:JSON.stringify({...r,...heavy,...(r.number===1?{
    [field]:field==='headRefOid'?'f'.repeat(40):'2026-11-25T12:00:01Z',
   }:{})})};
  }});
  expect(result.rows).toHaveLength(6);
  expect(result.rows[0]).toMatchObject({number:1,body:'',files:[],rowsComplete:false});
  expect(result.store.has(1)).toBe(false);
  expect(result.rows.slice(1).every(r=>r.body===heavy.body)).toBe(true);
 });
 it.each(['baseRefOid','baseRefName'])('a null %s defers only that row and never caches it',async field=>{
  const result=await pass([row(1,{[field]:null}),row(2)]);
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toMatchObject({number:1,body:'',files:[],rowsComplete:false});
  expect(result.rows[1].body).toBe(heavy.body);
  expect([...result.store.keys()]).toEqual([2]);
 });
 it('retries a moved read only once and accepts a second read matching the page identity',async()=>{
  const r=row(), execAsync=vi.fn()
   .mockResolvedValueOnce({stdout:JSON.stringify({...r,...heavy,headRefOid:'f'.repeat(40)})})
   .mockResolvedValueOnce({stdout:JSON.stringify({...r,...heavy})});
  const result=await pass([r],{execAsync});
  expect(execAsync).toHaveBeenCalledTimes(2);
  expect(result.rows[0].body).toBe(heavy.body);
  expect(result.rows[0].heavyReadError).toBeUndefined();
  expect(result.store.has(1)).toBe(true);
 });
 it('a second pass in a NEW process makes zero heavy reads for twenty unchanged non-candidates',async()=>{
  const dir=mkdtempSync(join(process.env.TMPDIR,'heavy-process-'));
  try {
   const rows=Array.from({length:20},(_,i)=>row(i+1));
   const first=await pass(rows); saveHeavyStore({repo,dir,entries:first.store});
   const source=`import {loadHeavyStore} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/heavy-cache.mjs')).href)};
    import {listOpenPrsPagedHydratedCompleteAsync as list} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/pr-list-paged.mjs')).href)};
    const result=await list({repo:${JSON.stringify(repo)},paging:${JSON.stringify(paging)},heavyFields:['body','files'],nowMs:${nowMs+1000},
    delta:{isCandidate:()=>false},store:loadHeavyStore({repo:${JSON.stringify(repo)},dir:${JSON.stringify(dir)}}).entries,
    exec:()=>${JSON.stringify(page(rows))},execAsync:async()=>{throw Error('unexpected read');}});
    console.log(JSON.stringify(result.stats));`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
   expect(child.status,child.stderr).toBe(0); expect(JSON.parse(child.stdout)).toMatchObject({fetched:0,reused:20});
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
   const path=storeFile(dir,'owner/name'), data=JSON.parse(readFileSync(path,'utf8'));
   data.entries[0].statusCheckRollup=[{conclusion:'SUCCESS'}]; data.entries[0].mergeable='MERGEABLE';
   writeFileSync(path,JSON.stringify(data));
   const second=await pass([row(1,{mergeable:'CONFLICTING',reviewDecision:'CHANGES_REQUESTED'})],{store:loadHeavyStore({repo,dir}).entries});
   expect(second.rows[0]).toMatchObject({mergeable:'CONFLICTING',reviewDecision:'CHANGES_REQUESTED',statusCheckRollup:[]});
   expect(second.stats.reused).toBe(1);
   second.rows[0].files[0].path='mutable'; expect(second.store.get(1).files[0].path).toBe('a.mjs');
  } finally {rmSync(dir,{recursive:true,force:true});}
 });
 it.each(['malformed','failed'])('one %s read among six joins the pool, leaves store and disk unchanged',async(kind)=>{
  const dir=mkdtempSync(join(process.env.TMPDIR,'heavy-failure-'));
  try {
   const rows=Array.from({length:6},(_,i)=>row(i+1)), first=await pass(rows);
   saveHeavyStore({repo,dir,entries:first.store}); const path=storeFile(dir,'owner/name'), before=readFileSync(path,'utf8');
   let finished=0;
   await expect(pass(rows,{store:first.store,delta:{isCandidate:()=>true},execAsync:async(_cmd,args)=>{
    await new Promise(resolve=>setImmediate(resolve)); finished++;
    const r=rows.find(r=>r.number===Number(args[2]));
    if(r.number===1 && kind==='failed') throw Error('fixture failure');
    return {stdout:JSON.stringify({...r,...heavy,...(r.number===1?{body:null}:{})})};
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

// Opt-in live acceptance: the ordinary suite is hermetic. Run on a network-enabled host
// with WE_HEAVY_CACHE_LIVE_ACCEPTANCE=1; retain stdout as the requested ET evidence.
it.skipIf(process.env.WE_HEAVY_CACHE_LIVE_ACCEPTANCE !== '1')('live two-process acceptance: second listing.pages is below 15000 ms with ET timestamps',()=>{
 const dir=mkdtempSync(join(process.env.TMPDIR,'heavy-live-acceptance-'));
 try {
  const et=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',dateStyle:'short',timeStyle:'long'}).format(new Date());
  const env={...process.env,WE_UNDER_TEST:'',VITEST:'',FAKE_GH_FIXTURE:'',WE_PR_SNAPSHOT:'1',
   WE_PR_SNAPSHOT_DIR:dir,WE_FAST_DRAIN_CONTEXT:'live',WE_FAST_DRAIN_LISTING:'live'};
  const run=()=>{
   const started=et();
   const child=spawnSync(process.execPath,['scripts/merge-ai-prs.mjs','--this-repo','--dry-run','--json',
    '--label=heavy-cache-acceptance-non-candidate','--no-drain-lease','--no-red-main-freeze',
    '--no-review-escalation','--repoll-delay=0'],{env,encoding:'utf8',timeout:180000,maxBuffer:16*1024*1024});
   const finished=et();
   console.log(JSON.stringify({startedET:started,finishedET:finished,status:child.status}));
   expect(child.status,child.stderr).toBe(0);
   const result=JSON.parse(child.stdout);
   const duration=result.timings?.['listing.pages'];
   expect(Number.isFinite(duration),child.stdout).toBe(true);
   console.log(JSON.stringify({startedET:started,finishedET:finished,listingPagesMs:duration}));
   return {duration,stderr:child.stderr};
  };
  run(); const second=run();
  expect(second.duration).toBeLessThan(15000);
 } finally {rmSync(dir,{recursive:true,force:true});}
},400000);

describe('delta fail-closed evidence', () => {
 it.each([false,true])('incomplete labels reject the page before hydration (candidate=%s)', async candidate => {
  const first = await pass([row()]);
  const execAsync = vi.fn(), isCandidate = vi.fn(() => candidate);
  await expect(pass([row(),row(2,{labels:{nodes:[],totalCount:1}})], {
   store:first.store, delta:{isCandidate}, execAsync,
  })).rejects.toMatchObject({name:'PrListUnreadableError', stage:'page', cause:expect.any(Error)});
  expect(execAsync).not.toHaveBeenCalled(); expect(isCandidate).not.toHaveBeenCalled();
  expect(first.store.size).toBe(1);
 });
 it.each(['heavyBackstopSeconds','heavySettleSeconds'])('invalid explicit %s prevents platform fallback and forces fresh reads', async key => {
  const path = join(snapshotDir,'preferences.json');
  writeFileSync(path,JSON.stringify({prListPaging:paging}));
  const env = {WE_PLATFORM_PREFERENCES_FILE:path};
  const first = await pass([row()]);
  // An absent tool leaf may inherit the platform; a present invalid leaf must disable reuse.
  expect(loadBounds(resolvePrListPaging({env,file:{}}))).not.toBeNull();
  for (const value of [undefined,null,NaN,-1,1.5,'5',{},[],key==='heavyBackstopSeconds'?604801:301]) {
   const resolved = resolvePrListPaging({env,file:{prListPaging:{[key]:value}}});
   expect(resolved[key]).toBeUndefined(); expect(resolved.source[key]).toBe('tool');
   expect(loadBounds(resolved)).toBeNull();
   const result = await pass([row()],{store:first.store,paging:resolved});
   expect(result.stats).toMatchObject({fetched:1,reused:0,byReason:{bounds:1}});
  }
 });
});
