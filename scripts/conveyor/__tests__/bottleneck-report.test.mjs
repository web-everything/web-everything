import { describe, it, expect, vi } from 'vitest';
import { buildReport, runBottleneckReport, renderMarkdown } from '../bottleneck-report.mjs';
import { analyzePr } from '../pr-time-core.mjs';
import { ghSlotWaitClass } from '../../lib/gh-throttle.mjs';
const now = Date.parse('2026-11-03T00:00:00Z'), hour = 3600000;
// Verbatim evidence from the fix daemon; the scope value is inert fixture data.
const scopeLog='2026-11-02T04:58:06.307Z reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #6193 — dispatch-lane: the value for {{SCOPE}} ("we:scripts/readiness/heavy-admission.mjs we:scripts/readiness/remote-exec.mjs") has characters the brief cannot carry safely — it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.';
const slice = (pr, causeKey, hours) => ({pr, bucket: 'wait', causeKey, reason: causeKey, start: now - hours * hour, end: now});
describe('report accounting', () => {
 it('ranks, normalizes per day, compares prior day, and exposes unknown evidence', () => {
  const r = buildReport({now, windowHours: 12, previous: {causes: [{key:'dispatch:scope-unsafe',perDay:2}]}, slicesByPr: [
   [slice(1,'dispatch:scope-unsafe',3)], [slice(2,'mq:removed-reentry',2)], [slice(3,'other:novel-reason',1)], [slice(4,'unknown:idle',1)]
  ]});
  expect(r.top3).toEqual(['dispatch:scope-unsafe','mq:removed-reentry','other:novel-reason']);
  expect(r.causes[0]).toMatchObject({hoursLost:3,perDay:6,prevPerDay:2,trendPct:200,state:'growing'});
  expect(r.causes[1].state).toBe('new');
  expect(r.unattributedHours).toBe(2); expect(r.namedPct).toBeCloseTo(500/7);
  expect(r.needsCode[0].key).toBe('other:novel-reason');
  expect(renderMarkdown(r)).toContain('dispatch:scope-unsafe');
 });
 it('clips to the report window and caps example PRs at five', () => {
  const r = buildReport({now, slicesByPr: Array.from({length:8}, (_,i) => [slice(i,'ci:queued',30)])});
  expect(r.wallHours).toBe(192); expect(r.causes[0].prs).toHaveLength(5); expect(r.causes[0].prCount).toBe(8);
 });
});
const pull = (start,end) => ({created_at:start,closed_at:end,head:{sha:'fixture-head'},title:'fixture'});
const log = (t,msg) => ({t:Date.parse(t),msg});
async function analyze(pr,P,timeline,logs) {
 return analyzePr(pr,{repo:'web-everything/web-everything',now,cache:{},
 gh:async path => path.includes('/timeline') ? timeline : path.includes('/actions/') ? {workflow_runs:[]} : P,
 readLog:async which => logs[which] || []});
}
describe('known attribution shapes', () => {
 it('does not backdate the first refusal across earlier idle time',async()=>{
  const start='2026-11-02T18:00:00Z', refusal='2026-11-02T21:00:00Z', end='2026-11-02T22:00:00Z';
  const rows=await analyze(6193,pull(start,end),[],{fix:[log(refusal,'refused dispatch-failed PR #6193 — SCOPE unsafe')]});
  expect(rows.map(s=>[s.causeKey,s.start,s.end])).toEqual([
   ['unknown:idle',Date.parse(start),Date.parse(refusal)],
   ['dispatch:scope-unsafe',Date.parse(refusal),Date.parse(end)],
  ]);
  const report=buildReport({now:Date.parse(end),slicesByPr:[rows]});
  expect(report.causes.find(c=>c.key==='unknown:idle').hoursLost).toBe(3);
  expect(report.causes.find(c=>c.key==='dispatch:scope-unsafe').hoursLost).toBe(1);
 });
 it('#6193-style fixing label uses the dominant real refusal instead of unattributed agent time',async()=>{
  const start='2026-11-02T04:58:06.307Z', end=new Date(Date.parse(start)+655*60000).toISOString();
  const rows=await analyze(6193,pull(start,end),[{event:'labeled',created_at:start,label:{name:'review-status:fixing'}}],
   {fix:Array.from({length:157},()=>scopeLog).concat([log(start,'reconcile-refused review-ci PR #6193')])});
  const report=buildReport({now:Date.parse(end),slicesByPr:[rows]});
  expect(report.top3[0]).toBe('dispatch:scope-unsafe');
  expect(report.causes[0].hoursLost*60).toBeCloseTo(655);
  expect(report.causes.some(c=>c.key==='fix:agent-unattributed')).toBe(false);
  expect(buildReport({now:Date.parse(end),windowHours:6,slicesByPr:[rows]}).causes[0].hoursLost).toBe(6);
 });
 it('#6193-shaped repeated dispatch refusals override an 11-hour fixing label until the first push',async()=>{
  const start=Date.parse('2026-11-02T04:00:00Z'), push=start+11*hour, end=push+hour;
  const fix=Array.from({length:150},(_,i)=>{
   const t=start+(i+1)*4*60000;
   return [log(new Date(t).toISOString(),scopeLog.replace(/^\S+ /,'')),
    log(new Date(t+1).toISOString(),'tagged review-status:fixing at dispatch PR #6193')];
  }).flat();
  const review=Array.from({length:600},(_,i)=>log(new Date(start+i*60000).toISOString(),
   'review-daemon: PR #6193 no review dispatched — owed a fix'));
  const rows=await analyze(6193,pull(new Date(start).toISOString(),new Date(end).toISOString()),[
   {event:'labeled',created_at:new Date(start).toISOString(),label:{name:'review-status:fixing'}},
   {event:'committed',sha:'pushed-head',committer:{date:new Date(push).toISOString()}},
  ],{fix,review});
  const report=buildReport({now:end,slicesByPr:[rows]});
  expect(report.top3[0]).toBe('dispatch:scope-unsafe');
  expect(report.causes.find(c=>c.key==='dispatch:scope-unsafe').hoursLost*60).toBeCloseTo(656);
  expect(report.causes.find(c=>c.key==='fix:agent-unattributed').hoursLost*60).toBeCloseTo(4);
  expect(rows.filter(s=>s.start>=push).every(s=>s.causeKey!=='dispatch:scope-unsafe')).toBe(true);
 });
 it('#6193 alternating admissions followed by scope refusals retain at least 600 refusal minutes in a ten-hour window',async()=>{
  const start=Date.parse('2026-11-02T05:00:00Z'), end=start+619*60000;
  const fix=Array.from({length:31},(_,i)=>{
   const admitted=i===0?1:24+(i-1)*20, refused=i===0?19:i===1?36:50+(i-2)*20;
   return [log(new Date(start+admitted*60000).toISOString(),'fix launch admitted PR #6193'),
    log(new Date(start+refused*60000).toISOString(),scopeLog.replace(/^\S+ /,''))];
  }).flat();
  const rows=await analyze(6193,pull(new Date(start).toISOString(),new Date(end).toISOString()),[
   {event:'labeled',created_at:new Date(start).toISOString(),label:{name:'review-status:fixing'}},
   {event:'committed',sha:'final-push',committer:{date:new Date(end).toISOString()}},
  ],{fix});
  const report=buildReport({now:end,windowHours:10,slicesByPr:[rows]});
  expect(report.top3[0]).toBe('dispatch:scope-unsafe');
  const refusalMinutes=report.causes.find(c=>c.key==='dispatch:scope-unsafe').hoursLost*60;
  expect(Math.round(refusalMinutes*1e6)/1e6).toBeGreaterThanOrEqual(600);
  expect(rows.filter(s=>s.end<=start+19*60000).every(s=>s.causeKey==='fix:agent-unattributed')).toBe(true);
 });
 it.each([30,31])('admission qualification uses a thirty-minute refusal horizon (%i minutes)',async minutes=>{
  const start='2026-11-02T18:00:00Z', admitted=Date.parse('2026-11-02T19:00:00Z'), end='2026-11-02T21:00:00Z';
  const rows=await analyze(6193,pull(start,end),[{event:'labeled',created_at:start,label:{name:'review-status:fixing'}}],{fix:[
   log(start,'refused dispatch-failed PR #6193 — SCOPE unsafe'),log(new Date(admitted).toISOString(),'fix launch admitted PR #6193'),
   log(new Date(admitted+minutes*60000).toISOString(),'refused dispatch-failed PR #6193 — SCOPE unsafe'),
  ]});
  expect(rows.find(s=>s.start<=admitted && s.end>admitted).causeKey).toBe(minutes<=30?'dispatch:scope-unsafe':'fix:agent-unattributed');
 });
 it.each(['transcript','push'])('a %s before a subsequent refusal protects admission qualification',async proof=>{
  const start='2026-11-02T18:00:00Z', admitted='2026-11-02T19:00:00Z', observed='2026-11-02T19:10:00Z', end='2026-11-02T21:00:00Z';
  const timeline=[{event:'labeled',created_at:start,label:{name:'review-status:fixing'}},
   ...(proof==='push'?[{event:'committed',sha:'hard-proof',committer:{date:observed}}]:[])];
  const rows=await analyzePr(6193,{repo:'a/b',now,transcripts:proof==='transcript'?[{s:Date.parse(observed),e:Date.parse(end),cat:'agent editing'}]:[],
   gh:async path=>path.includes('/timeline')?timeline:path.includes('/actions/')?{workflow_runs:[]}:pull(start,end),
   readLog:async which=>which==='fix'?[log(start,'refused dispatch-failed PR #6193 — SCOPE unsafe'),
    log(admitted,'fix launch admitted PR #6193'),log('2026-11-02T19:20:00Z','refused dispatch-failed PR #6193 — SCOPE unsafe')]:[]});
  expect(rows.find(s=>s.start===Date.parse(admitted))).toMatchObject({causeKey:'fix:agent-unattributed',end:Date.parse(observed)});
 });
 it.each(['launch admitted','transcript'])('genuine %s evidence keeps the remainder of a fixing window as agent time',async evidence=>{
  const start='2026-11-02T18:00:00Z',launch='2026-11-02T19:00:00Z',end='2026-11-02T21:00:00Z';
  const rows=await analyzePr(6193,{repo:'a/b',now,readLog:async which=>which==='fix' ? [
   log(start,'refused dispatch-failed PR #6193 — SCOPE unsafe'),
   ...(evidence==='launch admitted'?[log(launch,'fix launch admitted PR #6193')]:[]),
   log('2026-11-02T20:00:00Z','reconcile-refused fix-claimed PR #6193'),
  ] : [],transcripts:evidence==='transcript'?[{s:Date.parse(launch),e:Date.parse(end),cat:'agent editing'}]:[],
  gh:async path=>path.includes('/timeline')?[{event:'labeled',created_at:start,label:{name:'review-status:fixing'}}]:path.includes('/actions/')?{workflow_runs:[]}:pull(start,end)});
  const report=buildReport({now:Date.parse(end),slicesByPr:[rows]});
  expect(report.causes.find(c=>c.key==='dispatch:scope-unsafe').hoursLost).toBe(1);
  expect(report.causes.find(c=>c.key===(evidence==='transcript'?'fix:editing':'fix:agent-unattributed')).hoursLost).toBe(2);
  expect(rows.filter(s=>s.start>=Date.parse(launch)).every(s=>s.causeKey===
   (evidence==='transcript'?'fix:editing':'fix:agent-unattributed'))).toBe(true);
 });
 it.each(['envelope','detailed Analyze job'])('non-gating CodeQL %s preserves overlapping agent work including queued time',async source=>{
  const start='2026-11-02T18:00:00Z',begun='2026-11-02T18:30:00Z',end='2026-11-02T20:00:00Z';
  const editStart=Date.parse('2026-11-02T18:15:00Z'),editEnd=Date.parse('2026-11-02T19:45:00Z');
  const gh=vi.fn(async path=>{
   if(path.includes('/timeline'))return [];
   if(path.includes('/jobs'))return {jobs:[{id:1,name:'Analyze (javascript)',created_at:start,started_at:begun,completed_at:end}]};
   if(path.includes('/actions/'))return {workflow_runs:[{id:42,name:'CodeQL',status:'completed',created_at:start,updated_at:end,
    ...(source==='envelope'?{run_started_at:begun}:{})}]};
   return pull(start,end);
  });
  const rows=await analyzePr(1,{repo:'a/b',now,gh,readLog:async()=>[],transcripts:[{s:editStart,e:editEnd,cat:'agent editing'}]});
  expect(rows.map(s=>[s.causeKey,s.start,s.end])).toEqual([
   ['ci:non-gating',Date.parse(start),editStart],['fix:editing',editStart,editEnd],['ci:non-gating',editEnd,Date.parse(end)],
  ]);
  expect(buildReport({now:Date.parse(end),slicesByPr:[rows]}).causes.find(c=>c.key==='fix:editing').hoursLost).toBe(1.5);
  expect(gh.mock.calls.filter(([path])=>path.includes('/jobs'))).toHaveLength(source==='envelope'?0:1);
 });
 it('gating completed workflow envelopes retain priority over overlapping agent work',async()=>{
  const start='2026-11-02T18:00:00Z',begun='2026-11-02T18:30:00Z',end='2026-11-02T20:00:00Z';
  const rows=await analyzePr(1,{repo:'a/b',now,readLog:async()=>[],transcripts:[{s:Date.parse(start),e:Date.parse(end),cat:'agent editing'}],
   gh:async path=>path.includes('/timeline')?[]:path.includes('/actions/')?{workflow_runs:[{id:42,name:'CI',status:'completed',created_at:start,run_started_at:begun,updated_at:end}]}:pull(start,end)});
  expect(rows.map(s=>s.causeKey)).toEqual(['ci:queued','ci:running:ci']);
 });
 it('bounds CI work for a 22-commit PR and uses completed workflow timing without job reads',async()=>{
  const start='2026-11-02T00:00:00Z',end='2026-11-02T23:00:00Z', cache={};
  const gh=vi.fn(async path=>{
   if(path.includes('/timeline'))return Array.from({length:22},(_,i)=>({event:'committed',sha:`sha-${i}`,committer:{date:new Date(Date.parse(start)+i*hour).toISOString()}}));
   if(path.includes('/jobs'))throw Error('completed workflow must not need jobs');
   if(path.includes('/actions/'))return {workflow_runs:[{id:path,name:'CI',status:'completed',created_at:start,run_started_at:start,updated_at:end}]};
   return pull(start,end);
  });
  await analyzePr(6193,{repo:'a/b',gh,cache,now,readLog:async()=>[]});
  expect(gh.mock.calls.filter(([p])=>p.includes('head_sha='))).toHaveLength(4);
  expect(gh.mock.calls.length).toBeLessThanOrEqual(6);
  expect(cache.gaps.some(g=>g.why.includes('SHA'))).toBe(true);
 });
 it('reuses completed run job evidence across PR analyses with a fresh per-run cache',async()=>{
  const ciReads=new Map(), start='2026-11-02T18:00:00Z',end='2026-11-02T20:00:00Z';
  const gh=vi.fn(async path=>{
   if(path.includes('/timeline'))return [];
   if(path.includes('/jobs'))return {jobs:[{id:1,name:'merge-gate',created_at:start,started_at:start,completed_at:end}]};
   if(path.includes('/actions/'))return {workflow_runs:[{id:42,status:'completed',run_attempt:1,name:'CI'}]};
   return pull(start,end);
  });
  for(const pr of [1,2])await analyzePr(pr,{repo:'a/b',gh,now,cache:{ciReads},readLog:async()=>[]});
  expect(gh.mock.calls.filter(([p])=>p.includes('/jobs'))).toHaveLength(1);
  expect(ciReads.size).toBe(1);
 });
 it('preserves refusal through CI into continued wait until a successful dispatch supersedes it', async () => {
  const start='2026-11-02T18:00:00Z', end='2026-11-02T22:00:00Z';
  const rows=await analyzePr(6193,{repo:'a/b',now,readLog:async which=>which==='fix' ? [
   log(start,'refused dispatch-failed PR #6193 — SCOPE unsafe'),
   log('2026-11-02T21:00:00Z','fix launch admitted PR #6193'),
  ] : [], gh:async path=>{
   if(path.includes('/timeline'))return [];
   if(path.includes('/jobs'))return {jobs:[{id:1,name:'merge-gate',created_at:'2026-11-02T19:00:00Z',started_at:'2026-11-02T19:00:00Z',completed_at:'2026-11-02T20:00:00Z'}]};
   if(path.includes('/actions/'))return {workflow_runs:[{id:1,name:'CI'}]};
   return pull(start,end);
  }});
  expect(rows.map(s=>[s.causeKey,s.start,s.end])).toEqual([
   ['dispatch:scope-unsafe',Date.parse(start),Date.parse('2026-11-02T19:00:00Z')],
   ['ci:running:merge-gate',Date.parse('2026-11-02T19:00:00Z'),Date.parse('2026-11-02T20:00:00Z')],
   ['dispatch:scope-unsafe',Date.parse('2026-11-02T20:00:00Z'),Date.parse('2026-11-02T21:00:00Z')],
   ['unknown:idle',Date.parse('2026-11-02T21:00:00Z'),Date.parse(end)],
  ]);
 });
 it('#6193: scope refusal accounts for 655 minutes before dispatch', async () => {
  const start='2026-11-02T04:58:06.307Z', end=new Date(Date.parse(start)+655*60000).toISOString();
  const msg='reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #6193 — dispatch-lane: the value for {{SCOPE}} ("we:scripts/readiness/heavy-admission.mjs we:scripts/readiness/remote-exec.mjs") has characters the brief cannot carry safely — it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.';
  const rows=await analyze(6193,pull(start,end),[],{fix:[log(start,msg)]});
  expect(rows[0]).toMatchObject({pr:6193,causeKey:'dispatch:scope-unsafe',start:Date.parse(start),end:Date.parse(end)});
  expect((rows[0].end-rows[0].start)/60000).toBeCloseTo(655);
 });
 it('#6257: queue removal through next enqueue is re-entry wait', async () => {
  const start='2026-11-02T18:00:00Z', end='2026-11-02T20:00:00Z';
  const rows=await analyze(6257,pull(start,end),[
   {event:'added_to_merge_queue',created_at:start}, {event:'removed_from_merge_queue',created_at:'2026-11-02T18:15:00Z'},
   {event:'added_to_merge_queue',created_at:'2026-11-02T19:00:00Z'}],{});
  expect(rows.some(s=>s.causeKey==='mq:removed-reentry')).toBe(true);
 });
 it('retains red-team running across unrelated timeline events',async()=>{
  const start='2026-11-02T18:00:00Z', dispatch='2026-11-02T18:10:00Z', removed='2026-11-02T19:00:00Z', end='2026-11-02T20:00:00Z';
  const rows=await analyze(6239,pull(start,end),[
   {event:'labeled',created_at:start,label:{name:'red-team:pending'}},
   {event:'labeled',created_at:'2026-11-02T18:20:00Z',label:{name:'documentation'}},
   {event:'unlabeled',created_at:removed,label:{name:'red-team:pending'}},
   {event:'labeled',created_at:'2026-11-02T19:10:00Z',label:{name:'red-team:pending'}},
  ],{review:[log(dispatch,'review-daemon: web-everything/web-everything#6239 red team dispatched')]});
  expect(rows.filter(s=>s.causeKey==='redteam:running').map(s=>[s.start,s.end]))
   .toEqual([[Date.parse(dispatch),Date.parse(removed)]]);
  expect(rows.find(s=>s.start===Date.parse('2026-11-02T19:10:00Z')))
   .toMatchObject({causeKey:'redteam:pending-no-dispatch',end:Date.parse(end)});
 });
 it('#6239: ruling dispute from 13:54 to 14:46 ET', async () => {
  const start='2026-11-02T18:54:00Z',end='2026-11-02T19:46:00Z';
  const rows=await analyze(6239,pull(start,end),[{event:'labeled',created_at:start,label:{name:'red-team:pending'}}],
   {fix:[log(start,'reconcile-refused ruling-dispute web-everything/web-everything PR #6239')]});
  expect(rows[0].causeKey).toBe('redteam:ruling-dispute'); expect((rows[0].end-rows[0].start)/60000).toBe(52);
 });
 it('uses job names and preserves queued jobs without a start timestamp',async()=>{
  const start='2026-11-02T18:00:00Z',end='2026-11-02T20:00:00Z';
  const rows=await analyzePr(9,{repo:'a/b',now,cache:{},readLog:async()=>[],gh:async path=>{
   if(path.includes('/timeline'))return [];
   if(path.includes('/jobs'))return {jobs:[{id:1,name:'merge-gate',created_at:start,started_at:'2026-11-02T19:00:00Z',completed_at:end}]};
   if(path.includes('/actions/'))return {workflow_runs:[{id:1,name:'CI'}]};return pull(start,end);
  }});
  expect(rows.map(s=>s.causeKey)).toEqual(['ci:queued','ci:running:merge-gate']);
  const queued=await analyzePr(10,{repo:'a/b',now,cache:{},readLog:async()=>[],gh:async path=>{
   if(path.includes('/timeline'))return [];
   if(path.includes('/jobs'))return {jobs:[{id:2,name:'merge-gate',created_at:start}]};
   if(path.includes('/actions/'))return {workflow_runs:[{id:1,name:'CI'}]};return pull(start,end);
  }});
  expect(queued[0].causeKey).toBe('ci:queued');
 });
 it('refuses missing CI evidence and oversized pages for later full analysis',async()=>{
  for(const runs of [{}, {workflow_runs:Array.from({length:100},()=>({id:1}))}]) {
   await expect(analyzePr(9,{repo:'a/b',now,readLog:async()=>[],gh:async path=>path.includes('/timeline')?[]:path.includes('/actions/')?runs:pull('2026-11-02T18:00:00Z','2026-11-02T20:00:00Z')})).rejects.toThrow(/unreadable|bound exceeded/);
  }
 });
 it('bounds shared PR analyses and GitHub calls, retaining cached results', async () => {
  const cache={maxPrs:1,maxCalls:1}, gh=vi.fn(async()=>pull('2026-11-02T00:00:00Z','2026-11-02T01:00:00Z'));
  await expect(analyzePr(1,{repo:'a/b',gh,cache,readLog:async()=>[]})).rejects.toThrow(/budget/);
  await expect(analyzePr(2,{repo:'a/b',gh,cache,readLog:async()=>[]})).rejects.toThrow(/budget/);
  expect(gh).toHaveBeenCalledTimes(1);
 });
});
describe('report runner', () => {
 const setup=()=>{const files=new Map();return {files,deps:{fs:{readFile:async p=>{if(!files.has(p))throw Object.assign(Error('absent'),{code:'ENOENT'});return files.get(p);}, mkdir:async()=>{},writeFile:async(p,s)=>files.set(p,s),appendFile:async(p,s)=>files.set(p,(files.get(p)||'')+s)},listPrs:async()=>[{number:1,repo:'a/b'}],analyzePr:async()=>[slice(1,'ci:queued',1)]}};};
 it('indexes complete logs per PR including rotations and caches global drain holds',async()=>{
  const {deps}=setup();let checks=0;
  const drain='[drain-daemon] 2026-10-20T13:26:56.555Z enqueue-on-event: catch-up #5729 fast drain exit 0 in 572s — skipped: red-main-hold: shared freeze unreadable: branch unreadable: spawnSync git ETIMEDOUT; red-main-hold: main is red [manual] — nothing lands (no main-fix PR published yet) until main is green [outcome=skipped] · phases: listing=62605ms classifyGateReads=12355ms mergeCascade=11ms postMergeSync=35178ms duplicateCheck=430ms listing.snapshot=12994ms listing.defaultBranch=1817ms listing.target=2890ms listing.pages=13451ms listing.checks=4239ms listing.context=29017ms total=413390ms';
  deps.grepLog=vi.fn(async(pattern,path,options)=>{
   expect(options.timeout).toBeGreaterThan(0);expect(options.maxBuffer).toBeGreaterThan(0);
   if(pattern==='red-main-hold')return path.endsWith('.log')?drain:'';
   expect(['#6193([^0-9]|$)|PR 6193([^0-9]|$)','#6257([^0-9]|$)|PR 6257([^0-9]|$)']).toContain(pattern);
   return path.endsWith('fix-dispatch-daemon.log.1')?scopeLog:'';
  });
  deps.analyzePr=async(pr,{readLog,repo})=>{
   const first=await readLog('fix',pr,repo), second=await readLog('fix',pr,repo);
   expect(first).toEqual(second);expect(first[0].raw).toBe(scopeLog);
   expect((await readLog('drain',pr,repo))[0].raw).toBe(drain);
   expect((await readLog('drain',6257,repo))[0].raw).toBe(drain);checks++;
   return [slice(pr,'dispatch:scope-unsafe',1)];
  };
  await runBottleneckReport({dir:'state',now,deps,prs:[6193]});
  expect(checks).toBe(1);expect(deps.grepLog).toHaveBeenCalledTimes(12);
 });
 it('writes shadow files, history, and hourly stamp; next call skips', async()=>{
  const {deps,files}=setup();const first=await runBottleneckReport({dir:'state',now,deps});
  expect(first.summary).toContain('Top sinks');expect(files.has('state/bottleneck-report.md')).toBe(true);
  expect((await runBottleneckReport({dir:'state',now:now+1000,deps})).skipped).toBe(true);
 });
 it('trends against the preceding day rather than the preceding hour',async()=>{
  const {deps,files}=setup();
  files.set('state/bottleneck-history.jsonl',[
   {at:new Date(now-24*hour).toISOString(),causes:[{key:'ci:queued',perDay:0.5}]},
   {at:new Date(now-hour).toISOString(),causes:[{key:'ci:queued',perDay:5}]}
  ].map(row=>JSON.stringify(row)).join('\n')+'\n');
  await runBottleneckReport({dir:'state',now,deps});
  const r=JSON.parse(files.get('state/bottleneck-report.json'));
  expect(r.causes[0]).toMatchObject({prevPerDay:0.5,trendPct:100,state:'growing'});
 });
 it.each([1024,8*1024*1024+37])('production history reader requests at most 4 MiB from the tail and flags clipping (size %i)',async size=>{
  const {deps}=setup();delete deps.fs; // Exercise the production readTail branch, not injected readFile.
  const limit=4*1024*1024, dir='bounded-history', path=`${dir}/bottleneck-history.jsonl`;
  const prior={at:new Date(now-24*hour).toISOString(),causes:[{key:'ci:queued',perDay:0.5}]};
  host.files.clear();host.history={path,size,text:JSON.stringify(prior)+'\n',reads:[],closed:[]};host.active=true;
  try {
   const result=await runBottleneckReport({dir,now,deps});
   expect(result.completedAt).toEqual(expect.any(Number));
   expect(host.history.reads).toEqual([{fd:42,bufferBytes:Math.min(size,limit),offset:0,count:Math.min(size,limit),position:Math.max(0,size-limit)}]);
   expect(host.history.closed).toEqual([42]);
   const report=JSON.parse(host.files.get(`${dir}/bottleneck-report.json`));
   expect(report.causes[0].prevPerDay).toBe(0.5);
   expect(report.gapsFlagged.some(g=>g.source==='history' && g.why==='bounded history tail')).toBe(size>limit);
   expect(report.truncated).toBe(size>limit);
  } finally {host.active=false;host.history=null;}
 });
 it('writes a partial report and history with reserved grace after a hanging lister exhausts analysis',async()=>{
  const {deps,files}=setup();deps.listPrs=()=>new Promise(()=>{});
  const result=await runBottleneckReport({dir:'state',now,deps,budgetMs:5});
  expect(result).toMatchObject({truncated:true,error:expect.stringContaining('time budget')});
  expect(JSON.parse(files.get('state/bottleneck-report.json')).truncated).toBe(true);
  expect(files.has('state/bottleneck-report.md')).toBe(true);
  expect(files.get('state/bottleneck-history.jsonl')).toContain('"truncated":true');
 });
 it.each(['cadence','history'])('bounds a hanging filesystem %s reader by the whole-run deadline',async target=>{
  const {deps,files}=setup(), read=deps.fs.readFile;
  deps.fs.readFile=p=>p.endsWith(target==='cadence'?'bottleneck-report.json':'bottleneck-history.jsonl') ? new Promise(()=>{}) : read(p);
  deps.listPrs=vi.fn(deps.listPrs);
  const result=await runBottleneckReport({dir:'state',now,deps,budgetMs:5});
  expect(result).toMatchObject({truncated:true,error:expect.stringContaining('time budget')});
  expect(deps.listPrs).not.toHaveBeenCalled();
  expect(JSON.parse(files.get('state/bottleneck-report.json')).truncated).toBe(true);
 });
 it.each(['mkdir','markdown','history','stamp'])('bounds a hanging filesystem %s output by the remaining deadline',async target=>{
  const {deps,files}=setup(), write=deps.fs.writeFile;
  if(target==='mkdir')deps.fs.mkdir=()=>new Promise(()=>{});
  else if(target==='history')deps.fs.appendFile=()=>new Promise(()=>{});
  else deps.fs.writeFile=(p,s)=>p.endsWith(target==='markdown'?'bottleneck-report.md':'bottleneck-report.json') ? new Promise(()=>{}) : write(p,s);
  const result=await runBottleneckReport({dir:'state',now,deps,budgetMs:1000,writeGraceMs:20});
  expect(result).toMatchObject({truncated:true,error:expect.stringContaining('time budget')});
  expect(files.has('state/bottleneck-report.json')).toBe(false);
 });
 it('enforces the 40 PR cap for an injected analyzer as well',async()=>{
  const {deps,files}=setup();deps.listPrs=async()=>Array.from({length:41},(_,i)=>({number:i+1,repo:'a/b'}));
  deps.analyzePr=vi.fn(async pr=>[slice(pr,'ci:queued',1)]);
  expect((await runBottleneckReport({dir:'state',now,deps})).truncated).toBe(true);
  expect(deps.analyzePr).toHaveBeenCalledTimes(40);
  expect(JSON.parse(files.get('state/bottleneck-report.json')).gapsFlagged.some(g=>g.source==='analysis budget')).toBe(true);
 });
 it('records truncation and never lets dependency failures escape',async()=>{
  const {deps}=setup();expect((await runBottleneckReport({dir:'state',now,deps,budgetMs:0})).truncated).toBe(true);
  deps.listPrs=async()=>{throw Error('unreadable');};
  expect((await runBottleneckReport({dir:'other',now,deps})).error).toContain('unreadable');
 });
 it('writes all partial outputs even with zero analysis budget',async()=>{
  const {deps,files}=setup();
  const result=await runBottleneckReport({dir:'state',now,deps,budgetMs:0});
  expect(result).toMatchObject({truncated:true,completedAt:expect.any(Number)});
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({truncated:true,prsConsidered:0});
  expect(files.has('state/bottleneck-report.md')).toBe(true);
  expect(files.get('state/bottleneck-history.jsonl')).toContain('"truncated":true');
 });
 it('persists completed slices when the next PR exhausts analysis and resumes newest-first on the next tick',async()=>{
  const {deps,files}=setup(), calls=[];
  deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt:'2026-11-02T20:00:00Z'}, {number:2,repo:'a/b',updatedAt:'2026-11-02T21:00:00Z'}];
  deps.analyzePr=async pr=>{calls.push(pr);if(pr===1)return new Promise(()=>{});return [slice(pr,'ci:queued',1)];};
  expect((await runBottleneckReport({dir:'state',now,deps,budgetMs:20})).truncated).toBe(true);
  expect(calls).toEqual([2,1]);
  expect(JSON.parse(files.get('state/bottleneck-report.json')).prsConsidered).toBe(1);
  expect(Object.values(JSON.parse(files.get('state/bottleneck-slices.json')).entries)[0]).toMatchObject({number:2,updatedAt:'2026-11-02T21:00:00Z'});
  calls.length=0;deps.analyzePr=async pr=>{calls.push(pr);return [slice(pr,'ci:queued',1)];};
  await runBottleneckReport({dir:'state',now:now+5*60000,deps});
  expect(calls).toEqual([1]);
  expect(JSON.parse(files.get('state/bottleneck-report.json')).prsConsidered).toBe(2);
 });
 it('unchanged open PR continues accruing waiting hours across hourly reports',async()=>{
  const {deps,files}=setup();
  const updatedAt='2026-11-02T20:00:00Z', start=now-hour;
  deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt,state:'open'}];
  deps.analyzePr=vi.fn(async(pr,{now:asOf})=>[
   {pr,bucket:'idle/unowned',causeKey:'unknown:idle',reason:'idle/unowned',start,end:asOf},
  ]);
  await runBottleneckReport({dir:'state',now,deps});
  const first=JSON.parse(files.get('state/bottleneck-report.json'));
  await runBottleneckReport({dir:'state',now:now+hour,deps});
  const second=JSON.parse(files.get('state/bottleneck-report.json'));
  expect(deps.analyzePr).toHaveBeenCalledTimes(2);
  expect(first.wallHours).toBe(1);expect(second.wallHours).toBe(2);
  expect(second.causes.find(c=>c.key==='unknown:idle').hoursLost).toBe(2);
  expect(Object.values(JSON.parse(files.get('state/bottleneck-slices.json')).entries)[0])
   .toMatchObject({updatedAt,cachedAt:now+hour});
 });
 it('reanalyses a reopened cached final PR',async()=>{
  const {deps,files}=setup();let state='closed';
  const updatedAt='2026-11-02T20:00:00Z', start=now-hour;
  deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt,state}];
  deps.analyzePr=vi.fn(async(pr,{now:asOf})=>[
   {pr,bucket:'idle/unowned',causeKey:'unknown:idle',reason:'idle/unowned',start,end:state==='closed'?now:asOf},
  ]);
  await runBottleneckReport({dir:'state',now,deps});
  expect(Object.values(JSON.parse(files.get('state/bottleneck-slices.json')).entries)[0].final).toBe(true);
  state='open';
  // Force a resumable pass within the freshness interval, keeping the metadata version identical.
  const report=JSON.parse(files.get('state/bottleneck-report.json'));
  files.set('state/bottleneck-report.json',JSON.stringify({...report,truncated:true}));
  await runBottleneckReport({dir:'state',now:now+1000,deps,force:true});
  expect(deps.analyzePr).toHaveBeenCalledTimes(2);
  expect(JSON.parse(files.get('state/bottleneck-report.json')).causes.find(c=>c.key==='unknown:idle').hoursLost)
   .toBeCloseTo(1+1000/hour);
  expect(Object.values(JSON.parse(files.get('state/bottleneck-slices.json')).entries)[0])
   .toMatchObject({final:false,cachedAt:now+1000});
 });
 it('scrubs a planted token from every persisted artefact',async()=>{
  const {deps,files}=setup();const token='ghp_'+'a'.repeat(36);
  deps.analyzePr=async pr=>[{...slice(pr,'ci:queued',1),reason:`clone https://x:${token}@github.com/a/b failed`}];
  await runBottleneckReport({dir:'state',now,deps});
  for(const f of ['bottleneck-slices.json','bottleneck-report.json','bottleneck-report.md','bottleneck-history.jsonl'])
   expect(files.get('state/'+f)||'').not.toContain(token);
 });
 it('fails closed and persists nothing when the scrubber is unavailable',async()=>{
  const {deps,files}=setup();deps.scrub=null;
  const out=await runBottleneckReport({dir:'state',now,deps});
  expect(out.error).toMatch(/scrubber unavailable/);
  expect([...files.keys()].filter(k=>/bottleneck-(report|slices|history)/.test(k))).toEqual([]);
 });
 it('invalidates a final cache entry on reopen/reclose and marks the run truncated',async()=>{
  const {deps,files}=setup();let updatedAt='2026-11-02T20:00:00Z', end=now;
  deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt,state:'closed'}];
  deps.analyzePr=vi.fn(async pr=>[{pr,bucket:'idle/unowned',causeKey:'unknown:idle',reason:'idle/unowned',start:now-3*hour,end}]);
  await runBottleneckReport({dir:'state',now,deps});
  updatedAt='2026-11-02T22:00:00Z';
  await runBottleneckReport({dir:'state',now:now+1000,deps,force:true});
  expect(deps.analyzePr).toHaveBeenCalledTimes(2);
  const r=JSON.parse(files.get('state/bottleneck-report.json'));
  expect(r.truncated).toBe(true);
  expect(r.gapsFlagged.some(g=>/invalidated/.test(g.why))).toBe(true);
 });
 it('invalidates updated open PRs, retains final PRs across updates, and prunes entries after 72 hours',async()=>{
  const {deps,files}=setup();let updatedAt='2026-11-02T20:00:00Z';
  deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt,state:'open'}, {number:2,repo:'a/b',updatedAt:'2026-11-02T20:00:00Z',state:'closed'}];
  deps.analyzePr=vi.fn(async pr=>[slice(pr,'ci:queued',1)]);
  await runBottleneckReport({dir:'state',now,deps});
  updatedAt='2026-11-03T00:30:00Z';deps.analyzePr.mockClear();
  await runBottleneckReport({dir:'state',now:now+hour,deps});
  expect(deps.analyzePr.mock.calls.map(c=>c[0])).toEqual([1]);
  deps.listPrs=async()=>[];
  await runBottleneckReport({dir:'state',now:now+74*hour,deps});
  expect(Object.keys(JSON.parse(files.get('state/bottleneck-slices.json')).entries)).toHaveLength(0);
 });
 it('builds a partial report from cached slices when listing is throttled',async()=>{
  const {deps,files}=setup();deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt:'2026-11-02T20:00:00Z'}];
  await runBottleneckReport({dir:'state',now,deps});
  deps.listPrs=async()=>{throw Object.assign(Error('no gh slot'),{ghThrottled:{class:'background'}});};
  await runBottleneckReport({dir:'state',now:now+hour,deps});
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({truncated:true,prsConsidered:1});
 });
 it('rejects malformed cached slices and still publishes an explicitly incomplete report',async()=>{
  const {deps,files}=setup();
  files.set('state/bottleneck-slices.json',JSON.stringify({version:1,entries:{bad:{repo:'a/b',number:1,cachedAt:now,slices:[null]}}}));
  deps.listPrs=async()=>[];
  const result=await runBottleneckReport({dir:'state',now,deps});
  expect(result).toMatchObject({truncated:true,completedAt:expect.any(Number)});
  expect(JSON.parse(files.get('state/bottleneck-report.json')).gapsFlagged.some(g=>g.source==='slice cache')).toBe(true);
 });
 it('explicit PR numbers override listing and defer a throttled PR while progressing on the rest',async()=>{
  const {deps,files}=setup();deps.listPrs=vi.fn(()=>{throw Error('must not list');});
  deps.analyzePr=vi.fn(async pr=>{if(pr===6193)throw Object.assign(Error('no gh slot'),{ghThrottled:{class:'background'}});return [slice(pr,'ci:queued',1)];});
  await runBottleneckReport({dir:'state',now,deps,prs:[6193,6257,6239]});
  expect(deps.listPrs).not.toHaveBeenCalled();
  expect(deps.analyzePr.mock.calls.map(c=>c[0])).toEqual([6193,6257,6239]);
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({truncated:true,prsConsidered:2});
 });
 it('an inactive open PR last updated over 48 hours ago contributes current-window waiting hours through production listing',async()=>{
  const {deps,files}=setup();delete deps.listPrs;delete deps.analyzePr;deps.readLog=async()=>[];
  const updatedAt=new Date(now-72*hour).toISOString();
  deps.runGhSync=vi.fn(args=>{
   const path=args[1];
   if(path.startsWith('search/issues')) {
    const q=new URL(`https://fixture.invalid/${path}`).searchParams.get('q');
    if(q.includes('is:open')) {expect(q).not.toContain('updated:');return JSON.stringify({total_count:1,items:[{number:6193,state:'open',updated_at:updatedAt}]});}
    expect(q).toContain('is:closed updated:>=');return JSON.stringify({total_count:0,items:[]});
   }
   if(path.includes('/timeline'))return '[]';
   if(path.includes('/actions/'))return JSON.stringify({workflow_runs:[]});
   return JSON.stringify({...pull(new Date(now-96*hour).toISOString(),null),state:'open',updated_at:updatedAt});
  });
  await runBottleneckReport({dir:'state',now,deps});
  const report=JSON.parse(files.get('state/bottleneck-report.json'));
  expect(report).toMatchObject({prsListed:1,prsConsidered:1,wallHours:24,truncated:false});
  expect(report.causes.find(c=>c.key==='unknown:idle').hoursLost).toBe(24);
  expect(deps.runGhSync.mock.calls.filter(([args])=>args[1].startsWith('search/issues'))).toHaveLength(2);
 });
 it('production discovery paginates open PRs and deduplicates overlap with the closed search',async()=>{
  const {deps,files}=setup();delete deps.listPrs;
  deps.runGhSync=vi.fn(args=>{
   const params=new URL(`https://fixture.invalid/${args[1]}`).searchParams;
   const open=params.get('q').includes('is:open'), second=params.get('page')==='2';
   const items=open && !second?Array.from({length:100},(_,i)=>({number:i+1,state:'open'})):[{number:101,state:'open'}];
   return JSON.stringify({total_count:open?101:1,items});
  });
  deps.analyzePr=vi.fn(async pr=>[slice(pr,'unknown:idle',1)]);
  await runBottleneckReport({dir:'state',now,deps});
  expect(deps.runGhSync).toHaveBeenCalledTimes(3);
  expect(JSON.parse(files.get('state/bottleneck-report.json')).prsListed).toBe(101);
  expect(new Set(deps.analyzePr.mock.calls.map(c=>c[0])).size).toBe(deps.analyzePr.mock.calls.length);
 });
 it('production discovery flags its explicit search-result bound instead of claiming complete coverage',async()=>{
  const {deps,files}=setup();delete deps.listPrs;
  deps.runGhSync=vi.fn(args=>JSON.stringify(new URL(`https://fixture.invalid/${args[1]}`).searchParams.get('q').includes('is:open')?
   {total_count:1001,items:Array.from({length:100},(_,i)=>({number:i+1,state:'open'}))}:{total_count:0,items:[]}));
  await runBottleneckReport({dir:'state',now,deps});
  expect(deps.runGhSync).toHaveBeenCalledTimes(11);
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({truncated:true,
   gapsFlagged:expect.arrayContaining([expect.objectContaining({source:'PR listing',why:expect.stringContaining('1000-result bound')})])});
 });
 it('production lister and paginated reader stop at 128 total GitHub calls',async()=>{
  const {deps,files}=setup();delete deps.listPrs;delete deps.analyzePr;deps.readLog=async()=>[];
  deps.runGhSync=vi.fn(args=>{
   const path=args[1];
   if(path.startsWith('search/issues'))return JSON.stringify(new URL(`https://fixture.invalid/${path}`).searchParams.get('q').includes('is:open')?
    {total_count:0,items:[]}:{total_count:40,items:Array.from({length:40},(_,i)=>({number:i+1,state:'closed',updated_at:'2026-11-02T20:00:00Z'}))});
   if(path.includes('/timeline'))return JSON.stringify(path.endsWith('page=3')?[]:
    Array.from({length:100},()=>({event:'labeled',created_at:'2026-11-02T19:00:00Z',label:{name:'documentation'}})));
   if(path.includes('/actions/'))return JSON.stringify({workflow_runs:[]});
   return JSON.stringify(pull('2026-11-02T18:00:00Z','2026-11-02T20:00:00Z'));
  });
  const result=await runBottleneckReport({dir:'state',now,deps});
  expect(deps.runGhSync).toHaveBeenCalledTimes(128);
  expect(deps.runGhSync.mock.calls.filter(([args])=>args[1].startsWith('search/issues'))).toHaveLength(2);
  expect(deps.runGhSync.mock.calls.some(([args])=>args[1].includes('/timeline?per_page=100&page=3'))).toBe(true);
  // The fixture shares a head SHA across PRs: one CI-runs read is reused, including near the bound.
  expect(deps.runGhSync.mock.calls.filter(([args])=>args[1].includes('/actions/runs?head_sha='))).toHaveLength(1);
  expect(deps.runGhSync.mock.calls.at(-1)[0][1]).toContain('/pulls/32');
  expect(result).toMatchObject({truncated:true,error:expect.stringContaining('GitHub read budget exhausted')});
  expect(JSON.parse(files.get('state/bottleneck-report.json')).prsConsidered).toBe(31);
 });
 it('uses background throttle admission with a seconds-long wait on real reader calls',async()=>{
  const {deps}=setup();delete deps.analyzePr;deps.readLog=async()=>[];
  deps.runGhSync=vi.fn((args,options)=>{
   expect(ghSlotWaitClass({caller:options.throttle.caller,args,isWrite:false})).toBe('background');
   expect(options.throttle.acquireTimeoutMs).toBeGreaterThanOrEqual(2000);
   expect(options.throttle.acquireTimeoutMs).toBeLessThanOrEqual(8000);
   const path=args[1];return JSON.stringify(path.includes('/timeline')?[]:path.includes('/actions/')?{workflow_runs:[]}:pull('2026-11-02T18:00:00Z','2026-11-02T20:00:00Z'));
  });
  const result=await runBottleneckReport({dir:'state',now,deps,prs:[6193]});
  expect(result.completedAt).toEqual(expect.any(Number));expect(deps.runGhSync).toHaveBeenCalled();
 });
 it('resuming explicit final PRs only refreshes lifecycle metadata instead of repeating timeline and CI reads',async()=>{
  const {deps}=setup();delete deps.analyzePr;deps.readLog=async()=>[];
  deps.runGhSync=vi.fn(args=>JSON.stringify(args[1].includes('/timeline')?[]:args[1].includes('/actions/')?{workflow_runs:[]}:
   {...pull('2026-11-02T18:00:00Z','2026-11-02T20:00:00Z'),state:'closed',updated_at:'2026-11-02T20:00:00Z'}));
  await runBottleneckReport({dir:'state',now,deps,prs:[6193,6257,6239]});
  deps.runGhSync.mockClear();
  await runBottleneckReport({dir:'state',now:now+1000,deps,prs:[6193,6257,6239]});
  expect(deps.runGhSync).toHaveBeenCalledTimes(3);
  expect(deps.runGhSync.mock.calls.every(([args])=>/\/pulls\/\d+$/.test(args[1]))).toBe(true);
 });
 it('retains reduced CI precision warnings when cached final slices are reused',async()=>{
  const {deps,files}=setup();deps.listPrs=async()=>[{number:1,repo:'a/b',updatedAt:'2026-11-02T20:00:00Z',state:'closed'}];
  deps.analyzePr=async(pr,{cache})=>{cache.gaps.push({source:'PR 1 CI',why:'completed workflow timing used'});return [slice(pr,'ci:queued',1)];};
  await runBottleneckReport({dir:'state',now,deps});
  deps.analyzePr=vi.fn(()=>{throw Error('must reuse final slices');});
  await runBottleneckReport({dir:'state',now:now+hour,deps});
  expect(deps.analyzePr).not.toHaveBeenCalled();
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({truncated:true,
   gapsFlagged:expect.arrayContaining([{source:'PR 1 CI',why:'completed workflow timing used'}])});
 });
 it('a final-cache run with only precision warnings respects the hourly cadence',async()=>{
  const {deps,files}=setup();deps.listPrs=vi.fn(async()=>[{number:1,repo:'a/b',updatedAt:'2026-11-02T20:00:00Z',state:'closed'}]);
  deps.analyzePr=vi.fn(async(pr,{cache})=>{cache.gaps.push({source:'CI',why:'completed workflow timing used; individual job/idle detail unavailable'});return [slice(pr,'ci:queued',1)];});
  await runBottleneckReport({dir:'state',now,deps});
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({truncated:true,deferredWork:false});
  expect((await runBottleneckReport({dir:'state',now:now+5*60000,deps})).skipped).toBe(true);
  expect(deps.listPrs).toHaveBeenCalledTimes(1);expect(deps.analyzePr).toHaveBeenCalledTimes(1);
 });
 it('deferred PR work retries early with five-minute spacing and at most three consecutive early retries',async()=>{
  const {deps,files}=setup();deps.analyzePr=vi.fn(async()=>{throw Object.assign(Error('no gh slot'),{ghThrottled:{class:'background'}});});
  await runBottleneckReport({dir:'state',now,deps});
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({deferredWork:true,earlyRetries:0,cycleAt:now});
  expect((await runBottleneckReport({dir:'state',now:now+60000,deps})).skipped).toBe(true);
  for(const minutes of [5,10,15])await runBottleneckReport({dir:'state',now:now+minutes*60000,deps});
  expect(deps.analyzePr).toHaveBeenCalledTimes(4);
  expect((await runBottleneckReport({dir:'state',now:now+20*60000,deps})).skipped).toBe(true);
  expect(deps.analyzePr).toHaveBeenCalledTimes(4);
  await runBottleneckReport({dir:'state',now:now+hour,deps});
  expect(deps.analyzePr).toHaveBeenCalledTimes(5);
  expect(JSON.parse(files.get('state/bottleneck-report.json'))).toMatchObject({earlyRetries:0,cycleAt:now+hour});
 });
 it('rebuilds final slices from the prior attribution version instead of retaining backdated hours',async()=>{
  const {deps,files}=setup();deps.listPrs=async()=>[{number:1,repo:'a/b',state:'closed'}];
  files.set('state/bottleneck-slices.json',JSON.stringify({version:2,entries:{old:{repo:'a/b',number:1,final:true,cachedAt:now,slices:[slice(1,'dispatch:scope-unsafe',4)]}}}));
  deps.analyzePr=vi.fn(async()=>[slice(1,'dispatch:scope-unsafe',1)]);
  await runBottleneckReport({dir:'state',now,deps});
  expect(deps.analyzePr).toHaveBeenCalledTimes(1);
  expect(JSON.parse(files.get('state/bottleneck-report.json')).causes[0].hoursLost).toBe(1);
 });
});

// Host IO is fenced for tick integration and the production bounded-history reader.
const host = vi.hoisted(()=>({active:false,files:new Map(),history:null}));
const reportProbe=vi.hoisted(()=>({active:false,run:vi.fn()}));
vi.mock('../bottleneck-report.mjs',async original=>{
 const real=await original();return {...real,runBottleneckReport:(...args)=>reportProbe.active?reportProbe.run(...args):real.runBottleneckReport(...args)};
});
vi.mock('node:fs',async original=>{
 const real=await original();const missing=()=>{throw Object.assign(Error('fixture absent'),{code:'ENOENT'});};
 const fake={readFileSync:p=>host.files.has(String(p))?host.files.get(String(p)):missing(),
  existsSync:p=>host.files.has(String(p)),readdirSync:()=>[],
  statSync:p=>host.history && String(p)===host.history.path?{size:host.history.size}:missing(),lstatSync:missing,
  openSync:p=>host.history && String(p)===host.history.path?42:missing(),
  readSync:(fd,buffer,offset,count,position)=>{
   if(!host.history || fd!==42)return missing();
   host.history.reads.push({fd,bufferBytes:buffer.length,offset,count,position});
   buffer.fill(32);const text=(host.history.size>4*1024*1024?'discarded fragment\n':'')+host.history.text;
   buffer.write(text,buffer.length-Buffer.byteLength(text));return count;
  },
  closeSync:fd=>{if(!host.history || fd!==42)return missing();host.history.closed.push(fd);},
  mkdirSync:()=>{},appendFileSync:()=>{},unlinkSync:p=>host.files.delete(String(p)),
  writeFileSync:(p,v)=>host.files.set(String(p),v),renameSync:(a,b)=>{host.files.set(String(b),host.files.get(String(a)));host.files.delete(String(a));}};
 const wrapped=Object.fromEntries(Object.entries(fake).map(([k,f])=>[k,(...args)=>host.active?f(...args):real[k](...args)]));
 const memoryPromises={readFile:async p=>fake.readFileSync(p),mkdir:async()=>{},writeFile:async(p,v)=>fake.writeFileSync(p,v),
  appendFile:async(p,v)=>host.files.set(String(p),(host.files.get(String(p))||'')+v)};
 const promises={...real.promises,...Object.fromEntries(Object.entries(memoryPromises).map(([k,f])=>
  [k,(...args)=>host.active?f(...args):real.promises[k](...args)]))};
 return {...real,...wrapped,promises,default:{...real.default,...wrapped,promises}};
});
vi.mock('node:child_process',async original=>{
 const real=await original();const wrapped=Object.fromEntries(['execFileSync','execSync','spawn','spawnSync','execFile','exec','fork'].map(k=>[k,(...args)=>{if(host.active)throw Error('host subprocess forbidden');return real[k](...args);} ]));
 return {...real,...wrapped,default:{...real.default,...wrapped}};
});
vi.mock('../health-watch-section.mjs',async original=>({...await original(),healthDir:()=>'/fixture-health'}));
vi.mock('../pr-sweep-job.mjs',async original=>({...await original(),prSweepTickAllowed:()=>false}));
vi.mock('../nightly-coroner-job.mjs',async original=>({...await original(),nightlyCoronerTickAllowed:()=>false}));
vi.mock('../health-watch-job.mjs',async original=>({...await original(),resolveHealthJobSwitches:()=>({ghProbes:false})}));
vi.mock('../../lib/quiet-hours-io.mjs',async original=>({...await original(),flushDigest:vi.fn()}));
vi.mock('../../lib/ledger-readiness-daily.mjs',async original=>({...await original(),runDailyReadinessCheck:vi.fn()}));
vi.mock('../../operations/card-batch-seal-io.mjs',()=>({sealDueBatches:vi.fn()}));
vi.mock('../needs-you-feed-job.mjs',()=>({superviseNeedsYouFeed:vi.fn()}));
vi.mock('../archive-retention-tick.mjs',async original=>({...await original(),runArchiveRetentionTick:vi.fn(async()=>({results:[]}))}));
vi.mock('../main-ci-red-io.mjs',()=>({probeAndOwnMainCi:vi.fn(async()=>({runs:[]}))}));
vi.mock('../health-watch-main-red.mjs',()=>({runMainRedAlert:vi.fn()}));
import { tick } from '../health-watch.mjs';
describe('shadow tick wiring',()=>{
 async function run(enabled,runner,extra={},previous) {
  host.files.clear();host.files.set('/fixture-health/config.json',JSON.stringify({bottleneckReportEnabled:enabled,tmpSweepEnabled:false,claudeJobsArchiveEnabled:false}));
  if(previous)host.files.set('/fixture-health/state.json',JSON.stringify({bottleneckReport:previous}));
  host.active=true;
  try{return await tick({'state-root':'fixture','no-gh':true,'no-diagnose':true,'no-notify':true,'no-investigate':true,'no-file':true,now:new Date(now).toISOString(),...extra},
   {smells:[],collectInventory:()=>({}),...(runner?{runBottleneckReport:runner}:{})});}
  finally{host.active=false;}
 }
 it('disabled flag skips even an injected runner',async()=>{
  const runner=vi.fn();expect((await run(false,runner)).bottleneckReport).toBeNull();expect(runner).not.toHaveBeenCalled();
 });
 it('state-root and dry-run skip the production runner',async()=>{
  expect((await run(true)).bottleneckReport).toBeNull();
  expect((await run(true,undefined,{'dry-run':true})).bottleneckReport).toBeNull();
 });
 it.each(['no-gh','dry-run','state-root','logs-dir','lock-root','ps-fixture','machine-load-fixture','future-fixture',
  'claude-jobs-root','tmp-sweep-root','lane-pool-root','self-sync-dir','builder-log-dir'])('production bottleneck readers are fenced by --%s even with force-gh',async flag=>{
  reportProbe.active=true;reportProbe.run.mockReset().mockResolvedValue({completedAt:now,summary:'unexpected production read'});
  try {
   const value=['no-gh','dry-run'].includes(flag)?true:'fixture';
   const out=await run(true,undefined,{'state-root':undefined,'no-gh':false,'force-gh':true,[flag]:value});
   expect(out.bottleneckReport).toBeNull();expect(reportProbe.run).not.toHaveBeenCalled();
  } finally{reportProbe.active=false;}
 });
 it('force-gh bypasses cadence but no-gh still wins over force-gh',async()=>{
  const previous={at:now,completedAt:now,summary:'complete'},runner=vi.fn(async()=>({completedAt:now+1000,summary:'forced'}));
  await run(true,runner,{'no-gh':false,'force-gh':true,now:new Date(now+1000).toISOString()},previous);
  expect(runner).toHaveBeenCalledTimes(1);expect(runner.mock.calls[0][0].force).toBe(true);
  runner.mockClear();
  await run(true,runner,{'no-gh':true,'force-gh':true,now:new Date(now+1000).toISOString()},previous);
  expect(runner).not.toHaveBeenCalled();
 });
 it('enabled injected runner persists state and summary, and observes hourly state stamp',async()=>{
  const runner=vi.fn(async()=>({completedAt:now,summary:'Top sinks (24h): ci:queued 1 h/d'}));
  const out=await run(true,runner);
  expect(out.bottleneckReport.summary).toContain('Top sinks');
  expect(JSON.parse(host.files.get('/fixture-health/state.json')).bottleneckReport).toEqual({at:now,completedAt:now,summary:out.bottleneckReport.summary,deferredWork:false,cycleAt:now,earlyRetries:0});
  host.active=true;
  try {await tick({'state-root':'fixture','no-gh':true,'no-diagnose':true,'no-notify':true,'no-investigate':true,'no-file':true,now:new Date(now+1000).toISOString()},
   {smells:[],collectInventory:()=>({}),runBottleneckReport:runner});}
  finally{host.active=false;}
  expect(runner).toHaveBeenCalledTimes(1);
 });
 it.each([undefined,{at:now-2*hour,completedAt:now-2*hour,summary:'previous report'}])('returned report failure preserves cadence %j and the next tick retries',async previous=>{
  const failure={at:now,error:'report time budget exhausted',summary:'Bottleneck report: incomplete',truncated:true};
  const runner=vi.fn().mockResolvedValueOnce(failure).mockResolvedValueOnce({completedAt:now+1000,summary:'Top sinks (24h): ci:queued 1 h/d'});
  const out=await run(true,runner,{},previous);
  expect(out.bottleneckReport).toEqual(failure);
  expect(JSON.parse(host.files.get('/fixture-health/state.json')).bottleneckReport).toEqual(previous);
  host.active=true;
  try {await tick({'state-root':'fixture','no-gh':true,'no-diagnose':true,'no-notify':true,'no-investigate':true,'no-file':true,now:new Date(now+1000).toISOString()},
   {smells:[],collectInventory:()=>({}),runBottleneckReport:runner});}
  finally{host.active=false;}
  expect(runner).toHaveBeenCalledTimes(2);
  expect(JSON.parse(host.files.get('/fixture-health/state.json')).bottleneckReport).toMatchObject({at:now+1000,completedAt:now+1000});
 });
 it('runner failure is captured without escaping the tick',async()=>{
  const out=await run(true,async()=>{throw Error('report unavailable');});
  expect(out.probeErrors.bottleneckReport).toBe('report unavailable');
 });
 it('deferred partial reports retry after five minutes, while precision-only and legacy truncation stay hourly',async()=>{
  const previous={at:now,completedAt:now,summary:'partial',truncated:true,deferredWork:true,cycleAt:now,earlyRetries:0};
  const runner=vi.fn(async()=>({completedAt:now+5*60000,summary:'complete'}));
  await run(true,runner,{now:new Date(now+1000).toISOString()},previous);expect(runner).not.toHaveBeenCalled();
  await run(true,runner,{now:new Date(now+5*60000).toISOString()},previous);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(JSON.parse(host.files.get('/fixture-health/state.json')).bottleneckReport).toMatchObject({at:now+5*60000,cycleAt:now,earlyRetries:1});
  runner.mockClear();
  for(const deferredWork of [false,undefined])await run(true,runner,{now:new Date(now+5*60000).toISOString()},{...previous,deferredWork});
  await run(true,runner,{now:new Date(now+20*60000).toISOString()},{...previous,at:now+15*60000,earlyRetries:3});
  expect(runner).not.toHaveBeenCalled();
 });
});
