/** Hourly shadow report: owns only its reports, slice cache and history. No cards or alerts. */
import { promises as fs, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { runGhSync, isGhDeferred } from '../lib/gh-throttle.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { analyzePr } from './pr-time-core.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { scrubDeep } from './health-watch-core.mjs';
const HOUR = 3600000;
const ms = t => typeof t === 'number' ? t : Date.parse(t);
const unknown = key => /^(unknown:|other:|fix:agent-unattributed)/.test(key);
const RETRY_MS=5*60_000, MAX_EARLY_RETRIES=3;
const deferredFailure=e=>!!e?.ghThrottled || e?.code==='BOTTLENECK_DEADLINE' || /budget exhausted|no gh slot/i.test(String(e?.message || e));
/** Same production-reader fence as prSweepTickAllowed, including future fixture flags. */
export function bottleneckReportAllowed(flags={}) {
 return !Object.entries(flags).some(([key,value])=>value && (key.endsWith('-fixture') ||
  ['no-gh','dry-run','state-root','logs-dir','lock-root','claude-jobs-root','tmp-sweep-root','lane-pool-root','self-sync-dir','builder-log-dir'].includes(key)));
}
/** Precision warnings are not work. Only explicit deferred work earns spaced, capped early retries. */
export function bottleneckCadence(state,now,everyMs=HOUR,{force=false}={}) {
 const last=ms(state?.at), cycle=state?.cycleAt==null?last:ms(state.cycleAt);
 if(force || !Number.isFinite(last) || last<=0 || last>now || !Number.isFinite(cycle) || cycle<=0 || cycle>now || now-cycle>=everyMs)
  return {due:true,cycleAt:now,earlyRetries:0};
 const retries=state?.earlyRetries==null?0:Number.isInteger(state.earlyRetries) && state.earlyRetries>=0?state.earlyRetries:MAX_EARLY_RETRIES;
 const due=state?.deferredWork===true && now-last>=RETRY_MS && retries<MAX_EARLY_RETRIES;
 return {due,cycleAt:cycle,earlyRetries:due?retries+1:retries};
}

export function buildReport({slicesByPr, now = Date.now(), windowHours = 24, previous} = {}) {
 if (!(windowHours > 0) || !Number.isFinite(windowHours)) throw new Error('windowHours must be positive');
 const end = ms(now), start = end - windowHours * HOUR;
 const groups = slicesByPr instanceof Map ? [...slicesByPr.values()] : Array.isArray(slicesByPr) ? slicesByPr : Object.values(slicesByPr || {});
 const causes = new Map(), prs = new Set(); let wallHours = 0, unattributedHours = 0;
 for (const group of groups) {
  const slices = Array.isArray(group) ? group : group?.slices || [];
  for (const s of slices) {
   const hours = (Math.min(end,ms(s.end)) - Math.max(start,ms(s.start))) / HOUR;
   if (!Number.isFinite(hours) || hours <= 0) continue;
   const key = s.causeKey || 'unknown:idle';
   prs.add(s.pr); wallHours += hours;
   if (unknown(key)) unattributedHours += hours;
   if (!causes.has(key)) causes.set(key,{key,stage:key.startsWith('other:') ? 'unknown' : key.split(':')[0],reason:s.reason || s.bucket || key,hoursLost:0,prs:new Set()});
   const c = causes.get(key); c.hoursLost += hours; c.prs.add(s.pr);
  }
 }
 // Always publish the unexplained bucket, even when its measured size is zero.
 if (!causes.has('unknown:idle')) causes.set('unknown:idle',{key:'unknown:idle',stage:'unknown',reason:'idle/unowned',hoursLost:0,prs:new Set()});
 const ranked = [...causes.values()].map(c=>{
  const perDay = c.hoursLost * 24/windowHours;
  const prev = previous?.causes?.find(p=>p.key===c.key);
  const prevPerDay = prev?.perDay ?? null;
  const trendPct = prevPerDay > 0 ? (perDay/prevPerDay-1)*100 : null;
  const state = !prev || (prevPerDay === 0 && perDay > 0) ? 'new' : trendPct >= 50 ? 'growing' : trendPct < -10 ? 'shrinking' : 'steady';
  return {...c,perDay,prCount:c.prs.size,prs:[...c.prs].slice(0,5),prevPerDay,trendPct,state,signal:unknown(c.key) ? 'no' : /pickup-wait|pending-no-dispatch/.test(c.key) ? 'partial' : 'yes'};
 }).sort((a,b)=>b.hoursLost-a.hoursLost || a.key.localeCompare(b.key));
 const needsCode = ranked.filter(c=>c.key.startsWith('other:')).map(c=>({key:c.key,raw:c.reason,hoursLost:c.hoursLost}));
 return {at:new Date(end).toISOString(),windowHours,prsConsidered:prs.size,wallHours,namedPct:wallHours ? 100*(wallHours-unattributedHours)/wallHours : 0,
  causes:ranked,top3:ranked.filter(c=>c.hoursLost>0).slice(0,3).map(c=>c.key),unattributedHours,needsCode,
  gapsFlagged:ranked.filter(c=>unknown(c.key)&&c.hoursLost>0).map(c=>({source:c.key,why:'no signal'}))};
}
const clean = s => String(s).replace(/[\x00-\x1f\x7f]/g,' ').replace(/\|/g,'\\|').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function summary(report) {
 return `Top sinks (${report.windowHours}h): ${report.top3.map(key=>{const c=report.causes.find(c=>c.key===key);return `${key} ${c.perDay.toFixed(1)} h/d`;}).join(', ') || 'none'}; unexplained ${(100-report.namedPct).toFixed(1)}%${report.truncated ? '; partial (budget/evidence limit)' : ''}`;
}
export function renderMarkdown(report) {
 return `# Delivery bottlenecks (shadow)\n\n${clean(summary(report))}\n\n${report.at}; ${report.prsConsidered} PRs, ${report.wallHours.toFixed(2)} summed wall hours.\n\n| Cause | h/day | PRs | Trend | Signal |\n|---|---:|---:|---|---|\n${report.causes.map(c=>`| ${clean(c.key)} | ${c.perDay.toFixed(2)} | ${c.prCount} | ${c.trendPct == null ? c.state : `${c.trendPct.toFixed(0)}% (${c.state})`} | ${c.signal} |`).join('\n')}\n\nNeeds a code:\n${report.needsCode.map(c=>`- ${clean(c.key)}: ${clean(c.raw)}`).join('\n') || '- none'}\n\nEvidence gaps:\n${report.gapsFlagged.map(g=>`- ${clean(g.source)}: ${clean(g.why)}`).join('\n') || '- none'}\n`;
}

/** Bound history reads. A clipped read is never silently treated as complete evidence. */
function readTail(path, limit, onClipped) {
 const size = statSync(path).size, length = Math.min(size,limit), fd = openSync(path,'r');
 try {const buf=Buffer.alloc(length);readSync(fd,buf,0,length,size-length);let text=buf.toString('utf8');
  if(size>limit){onClipped(path);text=text.slice(text.indexOf('\n')+1);} return text;
 } finally {closeSync(fd);}
}
const grepLog = (pattern,path,options) => new Promise((resolve,reject)=>{
 execFile('grep',['-a','-E',pattern,path],options,(error,stdout)=>{
  if(error && error.code!==1)reject(error);else resolve(stdout || '');
 });
});
function defaultReaders({now, deadline, cache, gaps, runGh = runGhSync, searchLog = grepLog}) {
 const repo = ghRepoSlug('we');
 const workspace = join(homedir(),'workspace');
 const paths = {fix:join(workspace,'wev-fix-daemon','.conveyor','fix-dispatch-daemon.log'),review:join(workspace,'wev-review-daemon','.conveyor','review-daemon.log'),drain:join(workspace,'plateau-app','.drain-daemon','daemon.log'),build:join(resolveCoordinationRoot(),'build-dispatch-daemon.log')};
 const logCache = new Map();
 const gh = async (path,paginate=false) => {
  const remaining=deadline-Date.now(); if(remaining<=0) throw Error('report time budget exhausted');
  // Explicit page loop: every page consumes the shared call budget; no hidden --paginate/retry work.
  const page = p => {
   const remaining=deadline-Date.now();if(remaining<=0)throw Error('report time budget exhausted');
   // The health-watch caller family is background; leave time for execution after slot admission.
   const acquireTimeoutMs=Math.min(5000,Math.max(1,Math.floor(remaining/2)));
   const value=JSON.parse(runGh(['api',p],{encoding:'utf8',timeout:Math.min(5000,Math.max(1,remaining-acquireTimeoutMs)),maxBuffer:4*1024*1024,
    throttle:{caller:'health-watch:bottleneck-report',maxAttempts:1,acquireTimeoutMs,deferrable:true,env:{...process.env,WE_GH_JSON_RETRIES:'0'}}}));
   if(isGhDeferred(value))throw Object.assign(Error('GitHub admission deferred; retry PR next tick'),{ghThrottled:{class:'background'}});
   return value;
  };
  if (!paginate) return page(path);
  const out=[];
  for(let n=1;n<=10;n++) {
   if(n>1){if(cache.calls >= cache.maxCalls || Date.now()>=deadline)throw Error('pagination budget exhausted');cache.calls++;}
   const rows=page(`${path}${path.includes('?')?'&':'?'}per_page=100&page=${n}`);
   if(!Array.isArray(rows))throw Error('incomplete timeline evidence');out.push(...rows);
   if(rows.length<100)return out;
  }
  throw Error('timeline page bound exceeded; full evidence needs a later run');
 };
 return {repo,gh,
  listPrs:async ({since})=>{
   const found=new Map();
   // Metadata activity is not lifecycle overlap: inactive open PRs still accrue waiting time.
   for(const query of ['is:open',`is:closed updated:>=${since}`]) {
    try {
     for(let page=1;page<=10;page++) {
      if(cache.calls>=cache.maxCalls)throw Error('GitHub read budget exhausted');cache.calls++;
      const data=await gh(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr ${query}`)}&per_page=100&sort=updated&order=desc&page=${page}`);
      if(!Array.isArray(data.items) || !Number.isFinite(data.total_count))throw Error('PR listing unreadable');
      if(data.incomplete_results)gaps.push({source:'PR listing',why:`${query}: GitHub search evidence incomplete; retry discovery`});
      for(const p of data.items) {
       const prior=found.get(p.number);
       if(!prior || ms(p.updated_at)>ms(prior.updatedAt) || (p.state==='open' && prior.state!=='open'))
        found.set(p.number,{repo,number:p.number,updatedAt:p.updated_at,state:p.state,closedAt:p.closed_at});
      }
      if(page*100>=data.total_count)break;
      if(data.items.length<100){gaps.push({source:'PR listing',why:`${query}: search ended early; remaining PRs deferred`});break;}
      if(page===10)gaps.push({source:'PR listing',why:`${query}: 1000-result bound; partition the discovery query to cover remaining PRs`});
     }
    } catch(e){gaps.push({source:'PR listing',why:String(e.message)});if(deferredFailure(e))cache.deferredWork=true;if(/budget/.test(e.message))break;}
   }
   return [...found.values()];
  },
  readLog:async (which,number,repoName)=>{
   if(!Number.isInteger(number) || number<=0)throw Error('invalid log PR number');
   const keys=which==='drain'?['drain',`drain:${number}`]:[`${which}:${number}`];
   for(const key of keys)if(!logCache.has(key)) {
    const pattern=key==='drain'?'red-main-hold':`#${number}([^0-9]|$)|PR ${number}([^0-9]|$)`, lines=[];
    for(const suffix of ['', '.1', '.2']) {
     const remaining=deadline-Date.now();if(remaining<=0)throw Error('log read time budget exhausted');
     try {lines.push(await searchLog(pattern,paths[which]+suffix,{encoding:'utf8',timeout:Math.min(5000,remaining),maxBuffer:8*1024*1024}));}
     catch(e){const missing=e.code==='ENOENT' || (e.code===2 && /No such file/i.test(e.stderr || e.message));
      if(!suffix || !missing)gaps.push({source:`${which}${suffix}`,why:`indexed log read incomplete: ${e.code || 'error'}; retry with full evidence`});}
    }
    logCache.set(key,lines.join('\n').split('\n').flatMap(raw=>{
     const stamp=raw.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/);
     return stamp?[{t:Date.parse(stamp[0]),msg:raw,raw}]:[];
    }).filter(r=>Number.isFinite(r.t) && r.t<=now));
   }
   return keys.flatMap((key,i)=>logCache.get(key).filter(r=>i===0 || !/red-main-hold/.test(r.msg)))
    .filter(r=>!r.msg.includes('web-everything/') || r.msg.includes(repoName));
  }};
}

/** Analysis and publication have separate deadlines: exhausted analysis still publishes partial evidence. */
export async function runBottleneckReport({dir, now = Date.now(), deps = {}, budgetMs = 60000, everyMs = HOUR, writeGraceMs = 3000, prs, force=false} = {}) {
 const io=deps.fs || fs, clock=deps.clock || Date.now, at=ms(now);
 budgetMs=Number.isFinite(budgetMs)?Math.max(0,Math.min(60000,budgetMs)):60000;
 writeGraceMs=Number.isFinite(writeGraceMs)?Math.max(1,Math.min(5000,writeGraceMs)):3000;
 const deadline=clock()+budgetMs, gaps=[], cache={maxPrs:40,maxCalls:128,calls:0,ciReads:new Map(),gaps:[]};
 const limiter=(end)=>{
  let expired=false;
  return async fn=>{
   const remaining=end-clock();
   const timeout=()=>{expired=true;return Object.assign(Error('report time budget exhausted'),{code:'BOTTLENECK_DEADLINE'});};
   if(expired || remaining<=0)throw timeout();
   let timer;
   try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeout()),remaining);})]);}
   finally{clearTimeout(timer);}
  };
 };
 const bounded=limiter(deadline);
 const validSlices=slices=>Array.isArray(slices) && slices.every(s=>s && typeof s.causeKey==='string' && Number.isFinite(ms(s.start)) && Number.isFinite(ms(s.end)) && ms(s.end)>=ms(s.start));
 const entries=Object.create(null);let cacheLoaded=false, previous, listed=[], truncated=false, deferredWork=false;
 let cadence={cycleAt:at,earlyRetries:0};
 const record=(source,e,retry=deferredFailure(e))=>{truncated=true;deferredWork ||= retry;gaps.push({source,why:String(e?.message || e)});};
 const load=async(file)=>{
  try{return JSON.parse(await bounded(()=>io.readFile(join(dir,file),'utf8')));}
  catch(e){if(e.code==='BOTTLENECK_DEADLINE')throw e;if(e.code!=='ENOENT')record(file,e);return null;}
 };
 const readers={...defaultReaders({now:at,deadline,cache,gaps,runGh:deps.runGhSync || runGhSync,searchLog:deps.grepLog || grepLog}),...deps};
 try {
  const stored=await load('bottleneck-slices.json');
  if(stored && (![1,2,3,4,5,6,7,8].includes(stored.version) || !stored.entries || typeof stored.entries!=='object'))throw Error('slice cache unreadable; existing cache retained');
  for(const [path,row] of Object.entries(stored?.ciReads || {}).slice(-256))if(Number.isFinite(row?.at) && at-row.at<=72*HOUR && Array.isArray(row?.value?.jobs) && row.value.jobs.length<100)cache.ciReads.set(path,row);
  for(const [key,entry] of Object.entries(stored?.entries || {})) {
   if(!Number.isInteger(entry?.number) || !Number.isFinite(entry.cachedAt) || !validSlices(entry.slices)) {record('slice cache','invalid cached PR; deferred for fresh analysis');continue;}
   if(stored.version!==8){record('slice cache','attribution changed; rebuilding cached PR evidence');continue;}
   if(at-entry.cachedAt<=72*HOUR)entries[key]=entry;
  }
  cacheLoaded=true;
  const stamp=await load('bottleneck-report.json');
  // Explicit proof lists bypass cadence, but ordinary ticks keep the hourly gate.
  cadence=bottleneckCadence(stamp,at,everyMs,{force:force || prs!==undefined});
  if(!cadence.due)return {skipped:true,at:stamp.at,summary:'Bottleneck report: cadence hold'};
  let history='';
  try {history=await bounded(()=>deps.fs ? io.readFile(join(dir,'bottleneck-history.jsonl'),'utf8') : readTail(join(dir,'bottleneck-history.jsonl'),4*1024*1024,()=>record('history','bounded history tail')));}
  catch(e){if(e.code==='BOTTLENECK_DEADLINE')throw e;if(e.code!=='ENOENT')record('history',e);}
  previous=String(history).split('\n').filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)];}catch{record('history','malformed history row');return [];}})
   .filter(r=>ms(r.at)<=at-24*HOUR && ms(r.at)>at-25*HOUR).sort((a,b)=>ms(b.at)-ms(a.at))[0];
  const input=prs===undefined ? await bounded(()=>readers.listPrs({since:new Date(at-48*HOUR).toISOString(),until:new Date(at).toISOString(),now:at})) : prs;
  if(!Array.isArray(input))throw Error('PR listing unreadable');
  listed=[...new Map(input.map(p=>{const row=typeof p==='number'?{number:p}:p;return [`${row.repo || readers.repo}#${row.number}`,row];})).values()]
   .sort((a,b)=>(ms(b.updatedAt || b.updated_at)||0)-(ms(a.updatedAt || a.updated_at)||0));
  let attempts=0;
  for(const pr of listed) {
   const repo=pr.repo || readers.repo, number=Number(pr.number);
   let updatedAt=pr.updatedAt || pr.updated_at || null;
   if(!Number.isInteger(number) || number<=0){record('PR listing','invalid PR number');continue;}
   const current=Object.values(entries).find(e=>e.repo===repo && e.number===number);
   // Explicit numeric lists have no lifecycle evidence. Refresh one cheap metadata read before final reuse.
   if(prs!==undefined && current?.final && !pr.state) {
    try {
     if(cache.calls>=cache.maxCalls)throw Error('GitHub read budget exhausted');cache.calls++;
     const path=`repos/${repo}/pulls/${number}`, pull=await bounded(()=>readers.gh(path,false));
     if(!pull?.state)throw Error('PR lifecycle evidence missing');
     cache.reads ??= new Map();cache.reads.set(path,pull);
     pr.state=pull.state;updatedAt=pull.updated_at || null;
    } catch(e){record(`PR ${number}`,e);if(/budget/.test(e.message))break;continue;}
   }
   // Open lifecycle slices end at analysis time, so metadata equality is only fresh within this interval.
   // Short-term reuse lets partial passes resume without repeatedly analysing the same newest PRs.
   // A cached final lifecycle can reopen; only current closed-state evidence permits immutable reuse.
   // A final entry is reusable only when the PR is closed NOW and its lifecycle version (updatedAt) is unchanged;
   // a reopen/reclose changes updatedAt, so the entry is invalidated and the run is marked truncated.
   if(current?.final && !(pr.state==='closed' && updatedAt && current.updatedAt===updatedAt)) {
    for(const [key,e] of Object.entries(entries))if(e.repo===repo && e.number===number)delete entries[key];
    record(`PR ${number}`,'lifecycle changed or unverifiable (reopen/reclose); cached final slices invalidated',false);
   } else if(current && (current.final || (pr.state!=='closed' && updatedAt && current.updatedAt===updatedAt && at>=current.cachedAt && at-current.cachedAt<everyMs)))continue;
   if(clock()>=deadline || attempts>=cache.maxPrs || cache.calls>=cache.maxCalls){record('analysis budget','remaining PRs deferred to a later run',true);break;}
   attempts++;
   try {
    const ciGapStart=cache.gaps.length, ioGapStart=gaps.length;
    const slices=await bounded(()=>(readers.analyzePr || analyzePr)(number,{repo,gh:readers.gh,readLog:readers.readLog,now:at,cache}));
    if(!validSlices(slices))throw Error('PR slices unreadable');
    const pull=cache.reads?.get(`repos/${repo}/pulls/${number}`);
    const version=updatedAt || pull?.updated_at || null;
    const final=pr.state==='closed' || !!(pr.closedAt || pull?.closed_at || pull?.merged_at);
    for(const [key,e] of Object.entries(entries))if(e.repo===repo && e.number===number)delete entries[key];
    entries[JSON.stringify([repo,number,version])]={repo,number,updatedAt:version,final,cachedAt:at,slices,gaps:[...cache.gaps.slice(ciGapStart),...gaps.slice(ioGapStart)]};
   } catch(e) {
    record(`PR ${number}`,e);
    // Admission refusal is per PR, not a reason to abandon all remaining PRs.
    if(!e.ghThrottled && /budget/.test(e.message))break;
   }
  }
 } catch(e) {record('report inputs',e);}
 // Keep at most one version per PR. Even failed or throttled listings can report prior completed work.
 const selected=Object.values(entries).filter(e=>prs===undefined || prs.some(p=>Number(p.number ?? p)===e.number));
 const report=buildReport({slicesByPr:selected.map(e=>e.slices),now:at,previous});
 gaps.push(...cache.gaps,...selected.flatMap(e=>Array.isArray(e.gaps)?e.gaps:[]));
 const uniqueGaps=[...new Map(gaps.map(g=>[JSON.stringify(g),g])).values()];
 report.truncated=truncated || uniqueGaps.length>0;report.gapsFlagged.push(...uniqueGaps);report.prsListed=listed.length;
 report.deferredWork=deferredWork || cache.deferredWork===true;
 report.cycleAt=cadence.cycleAt;report.earlyRetries=cadence.earlyRetries;
 const line=summary(report), publish=limiter(clock()+writeGraceMs);
 try {
  // Every persisted artefact passes the shared credential scrubber; fail closed when it is unavailable.
  const scrub=deps.scrub===undefined?scrubDeep:deps.scrub;
  if(typeof scrub!=='function')throw Error('credential scrubber unavailable; nothing persisted');
  const safeReport=scrub(report), safeMd=scrub(renderMarkdown(report));
  const safeCache=cacheLoaded?scrub({version:8,entries,ciReads:Object.fromEntries([...cache.ciReads].slice(-256))}):null;
  await publish(()=>io.mkdir(dir,{recursive:true}));
  if(safeCache)await publish(()=>io.writeFile(join(dir,'bottleneck-slices.json'),JSON.stringify(safeCache)+'\n'));
  await publish(()=>io.writeFile(join(dir,'bottleneck-report.md'),safeMd));
  await publish(()=>io.appendFile(join(dir,'bottleneck-history.jsonl'),JSON.stringify(safeReport)+'\n'));
  await publish(()=>io.writeFile(join(dir,'bottleneck-report.json'),JSON.stringify(safeReport,null,2)+'\n'));
  return {at,completedAt:clock(),summary:line,truncated:report.truncated,deferredWork:report.deferredWork,cycleAt:report.cycleAt,earlyRetries:report.earlyRetries,...(truncated?{error:gaps.map(g=>g.why).join('; ')}:{})};
 } catch(e) {return {at,error:String(e?.message || e),summary:'Bottleneck report: incomplete (report IO failed)',truncated:true};}
}
