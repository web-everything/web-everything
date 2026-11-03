/** Importable priority sweep from the operations pr-time CLI. All IO is injected. */
import { normalizeGithubPr } from '../lib/pr-facts.mjs';
import { classifyReason, bucketCauseKey } from './cause-codes.mjs';
const PRI = {
  'local: tests/vitest': 1, 'local: verify-lane/check:standards': 1, 'local: codex audit': 1, 'local: heavy-queue wait': 1, 'local: git/gh': 1, 'local: other tool': 1,
  'CI running': 2, 'CI queued': 3,
  'agent editing': 3.5, 'agent job (no transcript - unknown)': 4,
  'review juror': 5, 'red-team running': 6, 'merge queue': 7, 'merge queue: re-entry wait': 7.5,
  'daemon pickup wait: fix': 8, 'daemon pickup wait: review': 8, 'daemon pickup wait: red-team': 8,
  'human/operator hold': 9, 'CI non-gating (CodeQL Analyze)': 9.5,
};


async function sweep(pr, {repo: REPO, gh, logLines, now, transcripts, cache}) {
  const P = await gh(`repos/${REPO}/pulls/${pr}`, false);
  if (!P) throw new Error('PR not readable');
  const facts = normalizeGithubPr({repo:REPO,pull:P});
  const start = Date.parse(P.created_at);
  if (!Number.isFinite(start)) throw new Error('PR lifecycle evidence missing');
  const end = P.merged_at ? Date.parse(P.merged_at) : P.closed_at ? Date.parse(P.closed_at) : now;
  const tl = await gh(`repos/${REPO}/issues/${pr}/timeline`);
  if (!Array.isArray(tl) || !P.head?.sha) throw new Error('PR timeline/head evidence missing');
  const iv = []; // {s,e,b,note}
  const add = (s, e, b, note) => { s = Math.max(s, start); e = Math.min(e, end); if (e > s) iv.push({ s, e, b, note }); };

  // label state machine
  const evs = [];
  for (const e of tl) {
    if (e.event === 'labeled') evs.push({ t: Date.parse(e.created_at), k: 'on', n: e.label.name });
    else if (e.event === 'unlabeled') evs.push({ t: Date.parse(e.created_at), k: 'off', n: e.label.name });
    else if (e.event === 'committed') evs.push({ t: Date.parse(e.committer.date), k: 'push', sha: e.sha });
    else if (/merge_queue|auto_merge_enabled|auto_merge_disabled/.test(e.event)) evs.push({ t: Date.parse(e.created_at), k: e.event });
  }
  evs.sort((a, b) => a.t - b.t);
  const pushes = [...new Set(evs.filter((e) => e.k === 'push').map((e) => e.t))];
  const state = []; // [t, Set]
  const cur = new Set();
  for (const e of evs) { if (e.k === 'on') cur.add(e.n); if (e.k === 'off') cur.delete(e.n); state.push({ t: e.t, set: new Set(cur) }); }
  const has = (set, re) => [...set].some((n) => re.test(n));

  // merge-queue windows from events
  let mq = null, removedAt = null;
  for (const e of evs) {
    if (e.k === 'added_to_merge_queue' || e.k === 'auto_merge_enabled') { if (removedAt != null) { add(removedAt, e.t, 'merge queue: re-entry wait', 'removed from queue -> next enqueue'); removedAt = null; } mq ??= e.t; }
    if ((e.k === 'removed_from_merge_queue' || e.k === 'auto_merge_disabled') && mq) { add(mq, e.t, 'merge queue', e.k); mq = null; removedAt = e.t; }
  }
  if (removedAt != null) add(removedAt, end, 'merge queue: re-entry wait', 'removed from queue -> next enqueue');
  if (mq) add(mq, end, 'merge queue', 'enqueued->merge');

  // fix windows: fixing label on -> first push after
  const fixWins = [];
  let fixOn = null;
  for (const s of state) {
    const f = has(s.set, /^(review-status|status):fixing$/);
    if (f && fixOn == null) fixOn = s.t;
    if (!f && fixOn != null) { const p1 = pushes.find((p) => p >= fixOn); fixWins.push([fixOn, Math.min(s.t, p1 ?? s.t)]); fixOn = null; }
  }
  if (fixOn != null) fixWins.push([fixOn, Math.min(end, pushes.find((p) => p >= fixOn) ?? end)]);
  // trim a fix window to its first push; state label can linger after the push
  for (const [a, b0] of fixWins) {
    const p1 = pushes.find((p) => p >= a);
    const b = p1 && p1 < b0 ? p1 : b0;
    if (b - a < 20e3) continue;
    add(a, b, 'agent job (no transcript - unknown)', 'fixing label->first push');
  }

  // Transcript intervals are supplied by the reader; no filesystem scan on a health tick.
  for (const t of transcripts) add(t.s, t.e, t.cat, 'transcript');

  // CI queued/running from actions jobs (per head sha); dedupe by job id
  const candidates = [...new Set([facts.headSha,...evs.filter(e=>e.k==='push').reverse().map(e=>e.sha)])];
  const shas = candidates.slice(0,4);
  if(candidates.length>shas.length)cache.gaps.push({source:`PR ${pr} CI`,why:`SHA bound: examined newest ${shas.length} of ${candidates.length}; earlier CI detail deferred`});
  const seen = new Set();
  let detailedRuns=0;
  for (const sha of shas) {
    const runData = await gh(`repos/${REPO}/actions/runs?head_sha=${sha}&per_page=100`, false);
    if (!Array.isArray(runData.workflow_runs)) throw new Error('CI runs unreadable');
    const runs = runData.workflow_runs;
    if (runs.length >= 100) throw new Error('CI run page bound exceeded; full evidence required');
    for (const r of runs) {
      const created=Date.parse(r.created_at), begun=Date.parse(r.run_started_at), finished=Date.parse(r.updated_at);
      if(r.status==='completed' && Number.isFinite(finished) && finished<=now-24*3600000)continue;
      // Completed workflow envelopes avoid a jobs call per historical run. Mark their reduced precision.
      if(r.status==='completed' && Number.isFinite(created) && Number.isFinite(begun) && Number.isFinite(finished)) {
        const nonGating=/\bcodeql\b/i.test(r.name || '') || /(?:^|\/)codeql(?:[.-]|$)/i.test(r.path || '');
        if(nonGating)add(created,finished,'CI non-gating (CodeQL Analyze)',r.name || 'CodeQL');
        else {
          add(created,begun,'CI queued',r.name || 'workflow');
          add(begun,finished,'CI running',r.name || 'workflow');
        }
        cache.gaps.push({source:`PR ${pr} CI run ${r.id}`,why:'completed workflow timing used; individual job/idle detail unavailable'});
        continue;
      }
      const jobPath=`repos/${REPO}/actions/runs/${r.id}/attempts/${r.run_attempt || 1}/jobs?per_page=100`;
      const saved=cache.ciReads.get(jobPath);
      if(!saved && detailedRuns>=3){cache.gaps.push({source:`PR ${pr} CI`,why:'job-read bound: additional run detail deferred'});continue;}
      if(!saved)detailedRuns++;
      const jobData = saved?.value || await gh(jobPath, false);
      if (!Array.isArray(jobData.jobs)) throw new Error('CI jobs unreadable');
      const jobs = jobData.jobs;
      if (jobs.length >= 100) throw new Error('CI job page bound exceeded; full evidence required');
      if(r.status==='completed')cache.ciReads.set(jobPath,{at:now,value:jobData});
      for (const j of jobs) {
        if (seen.has(j.id) || !j.created_at) continue; seen.add(j.id);
        const c = Date.parse(j.created_at), s = j.started_at ? Date.parse(j.started_at) : end, d = j.completed_at ? Date.parse(j.completed_at) : end;
        if (/^Analyze/.test(j.name)) { add(c, d, 'CI non-gating (CodeQL Analyze)', `${r.name}/${j.name}`); continue; } // not a required check (see coordination/required-status-checks-cache.json)
        add(c, s, 'CI queued', `${r.name}/${j.name}`);
        add(s, d, 'CI running', `${r.name}/${j.name}`);
      }
    }
  }

  // label-defined windows
  const walkState = (fn) => {
    let prev = start, set = new Set();
    for (const s of state) { if (s.t > prev) fn(prev, s.t, set); prev = Math.max(prev, s.t); set = s.set; }
    fn(prev, end, set);
  };
  const revLog = logLines('review', pr);
  const dispatches = revLog.filter((r) => /dispatched as job|red team dispatched/.test(r.msg));
  let redPendingSince=null, redDispatchAt=null;
  walkState((a, b, set) => {
    if(has(set,/^red-team:pending$/)) {
      redPendingSince ??= a;
      redDispatchAt ??= dispatches.find(x=>/red team dispatched/.test(x.msg) && x.t>=redPendingSince && x.t<b)?.t ?? null;
    } else {redPendingSince=null;redDispatchAt=null;}
    if (has(set, /^review-status:reviewing$/)) {
      const d = dispatches.filter((x) => /as job/.test(x.msg) && x.t <= a && a - x.t < 300e3).pop();
      add(d ? d.t : a, b, 'review juror', d ? 'dispatch log->result label' : 'reviewing label');
    } else if (has(set, /^red-team:pending$/)) {
      // running only after a red-team dispatch log line; before it = pickup wait
      // Dispatch persists across unrelated label/commit events until pending is removed.
      const dt = redDispatchAt;
      if (dt != null) { add(a, Math.max(a,dt), 'daemon pickup wait: red-team', 'red-team:pending before dispatch'); add(Math.max(a,dt), b, 'red-team running', 'dispatch->result'); }
      else add(a, b, 'daemon pickup wait: red-team', 'red-team:pending, no dispatch log (reasons below)');
    } else if (has(set, /^review:human$|^status:needs-you$/) && !has(set, /fixing|reviewing/)) {
      add(a, b, 'human/operator hold', [...set].filter((n) => /human|needs-you/.test(n)).join(','));
    } else if (has(set, /^review:changes$|^status:ci-red$|^ci:failed$/) && !has(set, /fixing/)) {
      add(a, b, 'daemon pickup wait: fix', 'changes/ci-red owed a fix, not yet fixing');
    } else if (has(set, /^status:awaiting-review$|^review:pending$/) && !has(set, /reviewing|fixing/)) {
      add(a, b, 'daemon pickup wait: review', 'awaiting-review, not yet reviewing');
    }
  });

  // sweep
  const cuts = [...new Set([start, end, ...iv.flatMap((x) => [x.s, x.e])])].sort((a, b) => a - b);
  const tot = {}; const slices = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i], b = cuts[i + 1];
    let best = null;
    for (const x of iv) if (x.s <= a && x.e >= b && (!best || PRI[x.b] < PRI[best.b])) best = x;
    const bk = best ? best.b : 'idle/unowned';
    tot[bk] = (tot[bk] || 0) + (b - a);
    const last = slices[slices.length - 1];
    if (last && last.b === bk && last.note === best?.note) last.e = b; else slices.push({ s: a, e: b, b: bk, note: best?.note });
  }
  return {slices,facts,pushes};
}

/** Shared cache bounds the entire run, including metadata, timelines, runs and jobs reads. */
export async function analyzePr(pr, {repo, gh, readLog = async () => [], now = Date.now(), cache = {}, transcripts = []} = {}) {
 const number = Number(pr.number ?? pr);
 const id = `${repo}#${number}`;
 cache.results ??= new Map(); cache.reads ??= new Map(); cache.analyses ??= 0; cache.calls ??= 0;
 cache.ciReads ??= new Map();cache.gaps ??= [];
 if (cache.results.has(id)) return cache.results.get(id);
 if (cache.analyses >= (cache.maxPrs ?? 40)) throw new Error('PR analysis budget exhausted');
 cache.analyses++;
 const read = async (path, paginate = true) => {
  if (cache.reads.has(path)) return cache.reads.get(path);
  if (cache.calls >= (cache.maxCalls ?? 128)) throw new Error('GitHub read budget exhausted');
  cache.calls++;
  const value = await gh(path, paginate);
  if (value == null) throw new Error(`Incomplete evidence: ${path}`);
  cache.reads.set(path,value); return value;
 };
 const logs = {};
 for (const which of ['fix','review','drain','build']) {
  const input = await readLog(which,number,repo);
  const rows = typeof input === 'string' ? input.split('\n').filter(l => new RegExp(`(?:#|PR )${number}\\b`).test(l) || /red-main-hold/.test(l)) : input;
  logs[which] = (rows || []).map(r => {
   if (typeof r !== 'string') return {...r,raw:r.raw || r.msg};
   const stamp = r.match(/\d{4}-\d\d-\d\dT[\d:.]+Z/);
   return {t:stamp ? Date.parse(stamp[0]) : NaN, msg:r, raw:r};
  }).filter(r=>Number.isFinite(r.t)).sort((a,b)=>a.t-b.t);
 }
 const result = await sweep(number,{repo,gh:read,logLines:which=>logs[which],now,transcripts,cache});
 // Reuse the common PR projection when shaping the cached metadata.
 cache.facts ??= new Map();
 cache.facts.set(id, result.facts);
 // A fixing-label tag is an attempted dispatch, not evidence that an agent actually launched.
 const dispatched = /fix launch admitted|dispatched as job|red team dispatched|fix push observed/;
 const pushes=result.pushes.map(t=>({t,msg:'fix push observed',raw:'fix push observed'}));
 // Admission can precede dispatch failure. Only an admission with no intervening refusal in the next
 // thirty minutes qualifies; transcript starts and pushes stop that lookahead as hard work evidence.
 const hardProofs=[...result.pushes,...transcripts.map(t=>t.s)].sort((a,b)=>a-b);
 const refusals=logs.fix.filter(r=>/refused/.test(r.msg));
 const failedAdmissions=new Set(logs.fix.filter(r=>{
  if(!/fix launch admitted/.test(r.msg))return false;
  const proof=hardProofs.find(t=>t>=r.t) ?? Infinity;
  return refusals.some(f=>f.t>=r.t && f.t<=r.t+30*60000 && f.t<proof);
 }));
 const reasons = [...Object.values(logs).flat(),...pushes].filter(r=>!failedAdmissions.has(r) && (dispatched.test(r.msg) || /no review dispatched|not dispatched|refused|owed a fix|red-main-hold|ruling-dispute|mq-same-head/.test(r.msg))).sort((a,b)=>a.t-b.t);
 // Fix dispatch evidence has its own lifetime: unrelated review holds cannot erase or outvote it.
 const fixEvents=[...logs.fix.filter(r=>!failedAdmissions.has(r) && /refused|fix launch admitted/.test(r.msg)).map(r=>({...r,kind:/fix launch admitted/.test(r.msg)?'launch':'refusal'})),
  ...pushes.map(r=>({...r,kind:'push'})),...transcripts.map(t=>({t:t.s,kind:'launch'}))].sort((a,b)=>a.t-b.t);
 let fixCursor=0, fixLaunched=false, fixRefusal=null;
 const fixCounts=new Map();
 const advanceFix=t=>{
  while(fixCursor<fixEvents.length && fixEvents[fixCursor].t<=t) {
   const event=fixEvents[fixCursor++];
   if(event.kind!=='refusal'){fixLaunched=event.kind==='launch';fixCounts.clear();fixRefusal=null;continue;}
   if(fixLaunched)continue;
   const key=classifyReason(event.raw).key, group=fixCounts.get(key) || {count:0,row:event};
   group.count++;fixCounts.set(key,group);
   fixRefusal=[...fixCounts.values()].sort((a,b)=>b.count-a.count)[0].row;
  }
 };
 const out = [];
 // Refusals describe dispatch state, independent of which bucket wins the accounting sweep.
 let cursor = 0, active = null;
 const counts = new Map();
 const advance = t => {
  advanceFix(t);
  while (cursor < reasons.length && reasons[cursor].t <= t) {
   const row = reasons[cursor++];
   if(dispatched.test(row.msg)){counts.clear();active=null;continue;}
   const key=classifyReason(row.raw).key, group=counts.get(key) || {count:0,row};
   group.count++;counts.set(key,group);
   active=[...counts.values()].sort((a,b)=>b.count-a.count)[0].row;
  }
 };
 for (const s of result.slices) {
  const waiting = /pickup wait|idle|^agent /.test(s.b);
  advance(s.s);
  // Observed agent/reviewer work also supersedes an earlier dispatch refusal.
  if (/^(agent editing|review juror|red-team running|local:)/.test(s.b)) {active = null;counts.clear();}
  const rows = waiting ? reasons.filter(r=>r.t>=s.s && r.t<s.e) : [];
  // Split at every observation; dominance uses only evidence already observed since dispatch/work.
  // A lingering fixing label alone does not prove an agent was launched.
  const cuts = [...new Set([s.s,...rows.map(r=>r.t),...(waiting?fixEvents.filter(r=>r.t>=s.s && r.t<s.e).map(r=>r.t):[]),s.e])].sort((a,b)=>a-b);
  for (let i=0;i<cuts.length-1;i++) {
   advance(cuts[i]);
   const row = !waiting ? null : /^agent /.test(s.b) ? (fixLaunched?null:fixRefusal) : fixRefusal || active;
   const reason = row?.raw || s.note || s.b;
   out.push({bucket:s.b,causeKey:row ? classifyReason(reason).key : bucketCauseKey(s.b,s.note),reason,start:cuts[i],end:cuts[i+1],pr:number});
  }
 }
 cache.results.set(id,out); return out;
}
