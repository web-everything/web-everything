#!/usr/bin/env node
/**
 * @file scripts/lib/enqueue-on-event.mjs
 * @description Card 257 "Enqueue as soon as checks finish" (coroner 2026-10-12; operator GO 2026-10-13).
 *
 * WHY. A PR that turned ready waited for the drain daemon's next FULL pass before it reached GitHub's merge queue.
 *   A full pass lists and classifies every queued PR first (1–7 min on 2026-10-13), and a failed pass (one PR's
 *   enqueue refused → exit 2) backs off 4–15 min with nudges ignored. Measured check-finish → enqueued on
 *   2026-10-13: median ~2 min, worst 25 min (#5175), 8 min (#5181).
 *
 * WHAT. When the drain's PR-events feed (`./pr-event-feed.mjs`, role `drain`) marks a PR with an event that can make
 *   it enqueue-eligible (a check suite finished green, or `review:accepted` / `ready-to-merge` was added), this runs
 *   the drain's EXISTING single-PR fast drain for that PR — `merge-ai-prs.mjs --only=<n> --label=ready-to-merge` —
 *   after a short debounce. That is the same per-PR path `/pr` and `/finish` use: every drain gate (AI authorship,
 *   required checks, review labels, blockedBy, couples, red-main holds, the enqueue clearance) runs on live state.
 *   Nothing here decides eligibility or enqueues; an event is only a wake for ONE PR (statute
 *   `#event-driven-land-is-wake-only`). A PR that is not ready is skipped by the drain exactly as a pass would.
 *
 * WHO CALLS IT. The resident drain daemon (plateau-app `tools/drain-daemon/daemon.mjs`) imports this from its WE
 *   clone, feeds it each feed poll (`notePoll`), and calls `tick()` ONLY while it sleeps between passes (never during
 *   a clone refresh or a pass: both use the same clone). Before its next pass it awaits `idle()`. So a fast drain and
 *   a full pass never run at the same time in one clone.
 *
 * SETTING `mergeQueue.enqueueOnEvent` — `{ enabled: boolean, debounceSeconds: number,
 *   catchUp: { enabled: boolean, intervalMinutes: number, maxQueued: number, missSmellAfter: number, order: string } }`, resolved through the shared
 *   policy cascade (`./policy-cascade.mjs`): standard default `{enabled:false, debounceSeconds:15, catchUp:{enabled:false, intervalMinutes:10, maxQueued:12, missSmellAfter:3, order:"priority-then-first-accept"}}` → platform
 *   preference `mergeQueue.enqueueOnEvent` → tool block `mergeQueue.enqueueOnEvent` in `we:scripts/settings/*.json`
 *   (this repo: `merge-queue.json`) → env `WE_ENQUEUE_ON_EVENT=on|off` (enabled only). Re-read on every tick; the
 *   source of each leaf is logged once per distinct value (`enqueue-on-event: setting …`).
 *   debounceSeconds: wait this long after the PR's LAST eligible event before running (check suites finish in a
 *   burst, and GitHub's mergeable state lags the last check by a few seconds).
 *
 *   missSmellAfter: positive integer (standard 3); every threshold of consecutive admission misses logs
 *   SMELL enqueue-not-entering. Enqueue claims are re-read from GitHub; misses retry next catch-up.
 *
 *   catchUp: when both enabled flags are true, list ready PRs on start and every intervalMinutes (1–240),
 *   priority class, build.priority list, then first acceptance (ready-time fallback); capped by maxQueued minus queued PRs; use the same fast-drain path. WHY: an
 *   event only wakes a PR that changes AFTER the feed started; a PR that was already ready never gets one and waits
 *   on full passes that end before reaching it ("ready-not-reached", live #5025 2026-10-13). Log lines start
 *   `enqueue-on-event: catch-up`. `tick()` runs it when due; `catchUp()` runs ONLY it, for a daemon whose passes
 *   run back to back (no post-pass sleep window) to call right before each pass.
 *
 * SCOPE. Only PRs of the local repo (the clone's origin): that is the repo whose ready PRs the drain enqueues on
 *   GitHub's merge queue. A mark with no PR number (`repo#?`) or a full-sweep mark (`*`) is left to the full pass.
 */
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { readBuildPrioritySettings, readBuildQueuePrioritySettings } from './build-queue.mjs';
import { rankByDeliveryPriority, PRIORITY_CLASSES } from './delivery-priority.mjs';
import { readMainRedPriority } from './main-red-priority.mjs';
import { extractManifestFromBody, repoKeyFromSlug } from '../readiness/lane-manifest.mjs';
import { parseVerdictComment } from './review-log-claims.mjs';
import { readCompletePrComments } from '../conveyor/pr-comments-complete.mjs';

export const ENQUEUE_ON_EVENT_POLICY = 'mergeQueue.enqueueOnEvent';
export const ENQUEUE_ON_EVENT_ENV = 'WE_ENQUEUE_ON_EVENT';
export const ENQUEUE_ON_EVENT_DEFAULTS = Object.freeze({ enabled: false, debounceSeconds: 15, catchUp: Object.freeze({ enabled: false, intervalMinutes: 10, maxQueued: 12, missSmellAfter: 3, order: 'priority-then-first-accept' }) });
/** A fast drain that runs longer than this is stopped (SIGTERM); the PR rides the next full pass. */
export const FAST_DRAIN_TIMEOUT_MS = 10 * 60_000;
const READY_LABEL = 'ready-to-merge';
const ELIGIBLE_LABELS = Object.freeze(['review:accepted', READY_LABEL]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validInterval = (v) => Number.isFinite(v) && v >= 1 && v <= 240;
const CATCH_UP_VALID = {
  enabled: (v) => typeof v === 'boolean',
  intervalMinutes: validInterval,
  maxQueued: (v) => Number.isInteger(v) && v >= 1,
  missSmellAfter: (v) => Number.isInteger(v) && v >= 1,
  order: (v) => ['priority-then-first-accept', 'oldest-ready'].includes(v),
};
const VALID = {
  catchUp: (v) => Object.values(CATCH_UP_VALID).some((valid) => valid(v)),
  enabled: (v) => typeof v === 'boolean',
  debounceSeconds: (v) => Number.isFinite(v) && v >= 0 && v <= 600,
};

/**
 * Resolve the setting. Never throws. `tool` defaults to the declared settings' `mergeQueue.enqueueOnEvent` block.
 * @returns {{enabled:boolean, debounceSeconds:number, catchUp:{enabled:boolean, intervalMinutes:number, maxQueued:number, missSmellAfter:number, order:string}, sources:Record<string,string>, invalid:string[], line:string}}
 */
export function resolveEnqueueOnEventSetting({ env = process.env, tool, platform } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readDeclaredSettings().settings?.mergeQueue?.enqueueOnEvent; } catch { block = undefined; }
  }
  const raw = String(env?.[ENQUEUE_ON_EVENT_ENV] ?? '').trim().toLowerCase();
  const envEnabled = raw === 'on' || raw === '1' || raw === 'true' ? true : raw === 'off' || raw === '0' || raw === 'false' ? false : undefined;
  const c = cascadePolicy(ENQUEUE_ON_EVENT_POLICY, isObj(block) ? block : undefined, {
    env, standard: { ...ENQUEUE_ON_EVENT_DEFAULTS }, envValues: { enabled: envEnabled }, valid: VALID,
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const v = isObj(c.value) ? c.value : {};
  const out = {
    enabled: v.enabled === true,
    debounceSeconds: VALID.debounceSeconds(v.debounceSeconds) ? v.debounceSeconds : ENQUEUE_ON_EVENT_DEFAULTS.debounceSeconds,
    catchUp: {},
    sources: { ...(c.sources || {}) },
    invalid: [...(c.invalid || []), ...(raw && envEnabled === undefined ? [`env ${ENQUEUE_ON_EVENT_ENV}=${JSON.stringify(raw)}`] : [])],
  };
  for (const leaf of Object.keys(CATCH_UP_VALID)) {
    const path = `catchUp.${leaf}`;
    const value = v.catchUp?.[leaf];
    const valid = CATCH_UP_VALID[leaf](value);
    out.catchUp[leaf] = valid ? value : ENQUEUE_ON_EVENT_DEFAULTS.catchUp[leaf];
    if (!valid) {
      if (value !== undefined) out.invalid.push(`${path}=${JSON.stringify(value)}`);
      out.sources[path] = 'standard';
    } else out.sources[path] ||= 'standard';
  }
  // The cascade rejects values outside the union before the per-leaf type check can see them.
  for (const invalid of c.invalid || []) {
    const match = /^(?:tool|platform)\.(catchUp\.(?:enabled|intervalMinutes|maxQueued|missSmellAfter|order)=.*)$/.exec(invalid);
    if (match && !out.invalid.includes(match[1])) out.invalid.push(match[1]);
  }
  const src = (k) => out.sources[k] || 'standard';
  out.line = `enqueue-on-event: setting ${ENQUEUE_ON_EVENT_POLICY} enabled=${out.enabled} (${src('enabled')}), debounceSeconds=${out.debounceSeconds} (${src('debounceSeconds')}), catchUp.enabled=${out.catchUp.enabled} (${src('catchUp.enabled')}), catchUp.intervalMinutes=${out.catchUp.intervalMinutes} (${src('catchUp.intervalMinutes')}), catchUp.maxQueued=${out.catchUp.maxQueued} (${src('catchUp.maxQueued')}), catchUp.missSmellAfter=${out.catchUp.missSmellAfter} (${src('catchUp.missSmellAfter')}), catchUp.order=${out.catchUp.order} (${src('catchUp.order')})${out.invalid.length ? ` · ignored invalid: ${out.invalid.join('; ')}` : ''}`;
  return out;
}

/**
 * Parse a feed mark's cause (pr-event-feed `describeEvent`: `type.action(label)=conclusion@seq[ via head commit]`). PURE.
 * @returns {{type:string, action:string, label:(string|null), conclusion:(string|null)}|null}
 */
export function parseMarkCause(cause) {
  const m = /^([a-z_]+)\.([a-z_]*)(?:\(([^)]*)\))?(?:=([a-z_]+))?@\d+/i.exec(String(cause ?? ''));
  if (!m) return null;
  return { type: m[1], action: m[2], label: m[3] ?? null, conclusion: m[4] ?? null };
}

/** Can this event make a PR enqueue-eligible? PURE. A green check suite / check run, or an eligibility label added. */
export function isEligibleCause(cause) {
  const c = parseMarkCause(cause);
  if (!c) return false;
  if ((c.type === 'check_suite' || c.type === 'check_run') && c.action === 'completed') return c.conclusion === 'success';
  if (c.type === 'pull_request' && c.action === 'labeled') return ELIGIBLE_LABELS.includes(c.label);
  return false;
}

/** `owner/name#123` → `{repo, num}`; null for `owner/name#?` and `*`. PURE. */
export function parseMarkKey(key) {
  const m = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(String(key ?? ''));
  return m ? { repo: m[1].toLowerCase(), num: Number(m[2]) } : null;
}

/**
 * Fold one feed poll's marks into the pending map (key → {repo, num, firstAt, lastAt, causes}). PURE: returns a new map.
 * Only eligible causes on a numbered PR of `localSlug` count.
 */
export function notePending(pending, marked, { localSlug, now }) {
  const next = new Map(pending);
  const local = String(localSlug ?? '').toLowerCase();
  for (const m of Array.isArray(marked) ? marked : []) {
    if (!isEligibleCause(m?.cause)) continue;
    const k = parseMarkKey(m?.key);
    if (!k || !local || k.repo !== local) continue;
    const key = `${k.repo}#${k.num}`;
    const prev = next.get(key);
    next.set(key, { ...k, ...(prev?.catchUp ? { catchUp: true } : {}), firstAt: prev?.firstAt ?? now, lastAt: now, causes: [...new Set([...(prev?.causes || []), String(m.cause).replace(/@\d+.*$/, '')])].slice(-3) });
  }
  return next;
}

/** The pending PRs whose debounce has elapsed, oldest first. PURE. */
export function duePending(pending, { now, debounceSeconds }) {
  return [...pending.values()].filter((p) => now - p.lastAt >= debounceSeconds * 1000).sort((a, b) => a.firstAt - b.firstAt);
}

/** The fast-drain argv (node script + args). The drain's own single-PR path; `--this-repo` keeps the listing local. PURE. */
export function fastDrainArgs({ scriptRoot, num }) {
  return [join(scriptRoot, 'scripts', 'merge-ai-prs.mjs'), `--only=${num}`, `--label=${READY_LABEL}`, '--this-repo', '--json'];
}

/** What the fast drain's JSON said about the target PR, in a few words. PURE. */
export function summarizeFastDrain(json, num) {
  if (!isObj(json)) return 'no JSON result';
  if (json.skipped === 'drain-in-progress') return `no-op (${json.detail || 'lease held'})`;
  if (json.ok === false) return `refused: ${json.reason}${json.detail ? ': ' + String(json.detail).slice(0, 200) : ''}`;
  const hit = (list) => (Array.isArray(list) ? list.find((x) => Number(x?.num) === Number(num)) : null);
  const failed = hit(json.failed);
  if (failed) return `failed: ${String(failed.detail || failed.reason || failed.error || '').slice(0, 200)}`;
  const outcome = hit(json.enqueueOutcomes);
  if (outcome?.outcome === 'not-enqueued') return `not enqueued: ${outcome.kind}: ${outcome.reason || ''}`.slice(0, 200);
  if (outcome?.outcome === 'enqueued') return `passed every drain gate — enqueued${outcome.already ? ' (already queued)' : ''}`;
  if (Array.isArray(json.enqueueOutcomes) && hit(json.toMerge)) return 'not enqueued: no enqueue outcome recorded';
  const aborted = hit(json.revalidationAborted);
  if (aborted) return `not enqueued: ${String(aborted.reason || aborted.detail || '').slice(0, 200)}`;
  // An enqueued PR is also listed in skipReasons ("ready-not-reached": queued, not merged), so toMerge wins over it.
  if (hit(json.merged) || hit(json.toMerge)) return 'passed every drain gate — enqueued';
  const skip = hit(json.skipReasons) || hit(json.skipped);
  if (skip) return `skipped: ${String(skip.reason || skip.kind || '').slice(0, 200)}`;
  if (!json.considered) return 'not listed (not ready-to-merge, closed, or already queued)';
  return 'no verdict for the PR';
}

/** A definite gate skip can release room; an ambiguous enqueue failure cannot. */
function fastDrainUsedNoRoom(json, num) {
  if (!isObj(json) || json.ok === false) return false;
  const hit = (list) => Array.isArray(list) && list.some((p) => Number(p?.num) === Number(num));
  if (hit(json.merged) || hit(json.failed)) return false;
  if ([json.revalidationAborted, json.deferred, json.coupleHeld, json.parked].some(hit)) return true;
  // toMerge is the planned set, so explicit non-enqueue outcomes above take precedence.
  // toMerge also appears in skipReasons after a successful enqueue (ready-not-reached).
  if (hit(json.toMerge)) return false;
  return hit(json.skipReasons) || hit(json.skipped);
}

/**
 * Is the PR worth a fast drain right now? A WAKE filter, never the gate: it only skips a run the drain would certainly
 * no-op (a fast drain lists and classifies for ~1 min, and most green-check events are for PRs that are not queued yet
 * or still have checks running; a later event wakes them again). The drain still re-reads everything live and decides.
 * A PR that could not be read is woken (the drain decides). PURE.
 * @param {{state?:string, isDraft?:boolean, labels?:Array<{name:string}>, statusCheckRollup?:Array<object>}|null} pr
 * @returns {{wake:boolean, reason:string}}
 */
export function wakeWorthy(pr) {
  if (!isObj(pr)) return { wake: true, reason: 'PR unread — the drain decides' };
  if (pr.state && pr.state !== 'OPEN') return { wake: false, reason: `PR is ${String(pr.state).toLowerCase()}` };
  if (pr.isDraft) return { wake: false, reason: 'draft' };
  const labels = (Array.isArray(pr.labels) ? pr.labels : []).map((l) => l?.name);
  if (!labels.includes(READY_LABEL)) return { wake: false, reason: `no ${READY_LABEL} label yet` };
  const running = (Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [])
    .filter((c) => (c?.__typename === 'StatusContext' ? ['PENDING', 'EXPECTED'].includes(String(c.state).toUpperCase()) : c?.status && c.status !== 'COMPLETED'));
  if (running.length) return { wake: false, reason: `${running.length} check(s) still running (${running.slice(0, 3).map((c) => c.name || c.context).join(', ')})` };
  return { wake: true, reason: 'ready-to-merge, every check finished' };
}

/** Default PR read for {@link wakeWorthy}: one `gh pr view`. Resolves null on any failure. */
export function readPrForWake({ repo, num, env = process.env, execFileImpl = execFile }) {
  return new Promise((res) => {
    execFileImpl('gh', ['pr', 'view', String(num), '--repo', repo, '--json', 'state,isDraft,labels,statusCheckRollup'], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) { res(null); return; }
      try { res(JSON.parse(String(stdout || 'null'))); } catch { res(null); }
    });
  });
}

/** Read GitHub's actual queue membership and latest admission/removal evidence. Never throws. */
export async function readMergeQueueMembership({ repo, num, env = process.env, execFileImpl = execFile } = {}) {
  try {
    const [owner, name] = String(repo || '').split('/');
    if (!owner || !name || !Number.isInteger(Number(num)) || Number(num) < 1) return { ok: false, error: 'invalid repo or PR number' };
    const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${Number(num)}){
      isInMergeQueue mergeQueueEntry{state position}
      timelineItems(last:5,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename
        ... on RemovedFromMergeQueueEvent{reason createdAt} ... on AddedToMergeQueueEvent{createdAt}}}}}}`;
    const result = await ghGraphql({ query, owner, name, env, execFileImpl });
    if (!result.ok) return result;
    const pr = result.repository.pullRequest;
    if (typeof pr?.isInMergeQueue !== 'boolean') return { ok: false, error: 'no pullRequest isInMergeQueue in the GraphQL answer' };
    return { ok: true, inQueue: pr.isInMergeQueue, entry: pr.mergeQueueEntry ?? null, lastEvents: pr.timelineItems?.nodes || [] };
  } catch (e) { return { ok: false, error: String(e?.message || e).split('\n')[0] }; }
}

export const CATCH_UP_QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){
  pullRequests(states:OPEN,labels:["ready-to-merge"],first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){nodes{number body isDraft isInMergeQueue} pageInfo{hasNextPage endCursor}}
  mergeQueue(branch:"main"){entries(first:100){totalCount}}}}`;

/**
 * When each PR got `ready-to-merge`: one aliased query, one `pullRequest(number:)` per PR. PURE. Asked per PR on
 * purpose: nested inside the `pullRequests` list, GitHub returned an even shorter label-event page (live
 * 2026-10-13: #5217 got 7 of 45 events). Either way the timeline can lag by an hour or more (live: every page
 * ended ~2h before the read), so a PR labeled after that lag reads `readyAt: null`. That PR became ready MOST
 * recently, which is why missing times sort last in {@link planCatchUp}. First acceptance comes from
 * the structured verdict comments (all heads); paginate comments so a long pre-review thread does not hide it.
 */
export function readyAtQuery(nums) {
  const one = (n) => `p${n}:pullRequest(number:${Number(n)}){timelineItems(itemTypes:[LABELED_EVENT],last:100){nodes{... on LabeledEvent{createdAt label{name}}}}}`;
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${nums.map(one).join(' ')}}}`;
}

/** The latest `ready-to-merge` LabeledEvent time (epoch ms) in a `timelineItems` block, or null. PURE. */
function latestReadyAt(timelineItems) {
  const dates = (timelineItems?.nodes || []).filter((e) => e?.label?.name === READY_LABEL)
    .map((e) => Date.parse(e.createdAt)).filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : null;
}

function ghGraphql({ query, owner, name, cursor, env, execFileImpl }) {
  return new Promise((resolve) => {
    const fail = (error) => resolve({ ok: false, error: String(error?.message || error).split('\n')[0] });
    try {
      execFileImpl('gh', ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`,
        ...(cursor === undefined ? [] : ['-f', `cursor=${cursor}`])],
        { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
          if (err) { fail(err); return; }
          try {
            const json = JSON.parse(String(stdout));
            if (Array.isArray(json.errors) && json.errors.length) { fail(json.errors[0]?.message || JSON.stringify(json.errors[0])); return; }
            if (!isObj(json.data?.repository)) { fail('no repository in the GraphQL answer'); return; }
            resolve({ ok: true, repository: json.data.repository });
          } catch (e) { fail(e); }
        });
    } catch (e) { fail(e); }
  });
}

/**
 * IO: the open ready-to-merge PRs of `repo` and the merge queue's size, through the GraphQL repository connection
 * (never the issue-search budget `gh pr list --label` uses). Then, for the PRs that are neither drafts nor queued,
 * when each got its label and first acceptance (ready-time fallback when acceptance is unreadable). Never rejects.
 * @returns {Promise<{ok:true, prs:Array<{num:number, isDraft:boolean, inQueue:boolean, readyAt:(number|null)}>, queued:number}|{ok:false, error:string}>}
 */
export async function readCatchUpCandidates({ repo, env = process.env, execFileImpl = execFile, readComments = readCompletePrComments }) {
  const [owner, name] = String(repo ?? '').split('/');
  if (!owner || !name) return { ok: false, error: `not an owner/name repo: ${JSON.stringify(repo)}` };
  const prs = [];
  const seenCursors = new Set();
  let cursor;
  let queued = 0;
  for (;;) {
    const list = await ghGraphql({ query: CATCH_UP_QUERY, owner, name, cursor, env, execFileImpl });
    if (!list.ok) return list;
    const { nodes, pageInfo } = list.repository.pullRequests ?? {};
    if (!Array.isArray(nodes)) return { ok: false, error: 'no pullRequests in the GraphQL answer' };
    if (typeof pageInfo?.hasNextPage !== 'boolean') return { ok: false, error: 'no pullRequests pageInfo in the GraphQL answer' };
    if (cursor === undefined) queued = list.repository.mergeQueue?.entries?.totalCount ?? 0;
    prs.push(...nodes.map((pr) => ({ ...(pr.body ? { itemIds: [extractManifestFromBody(pr.body)?.item].filter((id) => id != null).map(String) } : {}), num: pr.number, isDraft: pr.isDraft === true, inQueue: pr.isInMergeQueue === true, readyAt: null })));
    if (!pageInfo.hasNextPage) break;
    const next = pageInfo.endCursor;
    if (typeof next !== 'string' || !next || seenCursors.has(next)) return { ok: false, error: 'invalid pullRequests pagination cursor' };
    seenCursors.add(next);
    cursor = next;
  }
  const open = prs.filter((p) => !p.isDraft && !p.inQueue);
  // Keep each aliased timeline query bounded even when the listing spans many pages.
  for (let offset = 0; offset < open.length; offset += 100) {
    const batch = open.slice(offset, offset + 100);
    const times = await ghGraphql({ query: readyAtQuery(batch.map((p) => p.num)), owner, name, env, execFileImpl });
    if (times.ok) for (const p of batch) {
      const record = times.repository[`p${p.num}`];
      p.readyAt = latestReadyAt(record?.timelineItems);
      try {
        const dates = (await readComments(p.num, { repo })).flatMap((comment) => {
          const verdict = parseVerdictComment(comment);
          const date = Date.parse(comment.createdAt);
          return ['accepted', 'clear-human'].includes(verdict?.kind) && Number.isFinite(date) ? [date] : [];
        });
        if (dates.length) p.firstAcceptedAt = Math.min(...dates);
      } catch { /* Keep the ready-time fallback when the complete thread is unreadable. */ }
    }
  }
  return { ok: true, prs, queued };
}

/** IO: catch-up fill depth, independent of GitHub's build batch size. */
export function readQueueCapacity(setting = resolveEnqueueOnEventSetting()) {
  return { capacity: setting.catchUp?.maxQueued ?? ENQUEUE_ON_EVENT_DEFAULTS.catchUp.maxQueued,
    source: `mergeQueue.enqueueOnEvent.catchUp.maxQueued (${setting.sources?.['catchUp.maxQueued'] || 'standard'})` };
}

/** PURE: ordered candidates that fit the current queue, leaving eligibility to the drain. */
export function planCatchUp({ prs, queued, capacity, pendingNums = [], order = 'priority-then-first-accept',
  priority, buildPriority = [], mainFix = null, repo, now = 0 }) {
  const pending = new Set(pendingNums);
  const skipped = []; const candidates = [];
  for (const pr of prs) {
    const reason = pr.isDraft ? 'draft' : pr.inQueue ? 'already queued' : pending.has(pr.num) ? 'already pending' : null;
    if (reason) skipped.push({ num: pr.num, reason });
    else candidates.push(pr);
  }
  const classes = new Map(rankByDeliveryPriority(candidates.map((pr) => ({ id: pr.num, facts: {
    waitingSince: pr.firstAcceptedAt ?? pr.readyAt,
    incident: { open: !!mainFix, owner: !!mainFix && [mainFix.pr, ...(mainFix.prs || [])].includes(pr.num) &&
      (mainFix.repo ?? 'we') === repoKeyFromSlug(repo) },
  } })), priority, now).map((p) => [p.id, PRIORITY_CLASSES.indexOf(p.class)]));
  const buildIndex = (pr) => {
    const positions = (pr.itemIds || []).map((id) => buildPriority.indexOf(String(id))).filter((i) => i >= 0);
    return positions.length ? Math.min(...positions) : Infinity;
  };
  const age = (pr) => (order === 'oldest-ready' ? pr.readyAt : pr.firstAcceptedAt ?? pr.readyAt) ?? Infinity;
  candidates.sort((a, b) => (order === 'oldest-ready' ? 0 :
    classes.get(a.num) - classes.get(b.num) || buildIndex(a) - buildIndex(b)) || age(a) - age(b) || a.num - b.num);
  const room = Math.max(0, capacity - queued);
  return { run: candidates.slice(0, room).map(({ num, readyAt }) => ({ num, readyAt })),
    later: candidates.slice(room).map((p) => p.num), skipped };
}

function runChild({ args, cwd, env, spawnImpl, timeoutMs, onChild = () => {} }) {
  return new Promise((resolveRun) => {
    let stdout = ''; let stderrTail = '';
    let child;
    try { child = spawnImpl(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolveRun({ code: null, stdout: '', error: String(e?.message || e) }); return; }
    onChild(child);
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    killer.unref?.();
    child.on('error', (e) => { clearTimeout(killer); resolveRun({ code: null, stdout, stderrTail, error: String(e?.message || e) }); });
    child.on('close', (code) => { clearTimeout(killer); resolveRun({ code, stdout, stderrTail }); });
  });
}

const lastJsonLine = (s) => {
  const lines = String(s || '').trim().split('\n').reverse();
  for (const l of lines) { try { const j = JSON.parse(l); if (isObj(j)) return j; } catch { /* not JSON */ } }
  return null;
};

/**
 * The daemon-side handle.
 * @param {{cwd:string, localSlug:string, scriptRoot?:()=>string, allowed?:()=>boolean, log?:(m:string)=>void,
 *   env?:object, now?:()=>number, spawnImpl?:Function, resolveSetting?:Function, timeoutMs?:number, readPr?:Function, readMembership?:Function, readCandidates?:Function, readCapacity?:Function, readPriorities?:Function}} o
 *   `cwd` the drain's data clone (the fast drain runs there, like a pass). `scriptRoot()` the pass code root (data
 *   clone, or the code clone carrying overlays). `allowed()` true only while the caller sleeps between passes.
 */
export function createEnqueueOnEvent({
  cwd, localSlug, scriptRoot = () => cwd, allowed = () => true, log = (m) => process.stderr.write(`${m}\n`),
  env = process.env, now = () => Date.now(), spawnImpl = spawn, resolveSetting = () => resolveEnqueueOnEventSetting({ env }),
  readCandidates = ({ repo }) => readCatchUpCandidates({ repo, env }), readCapacity = (s) => readQueueCapacity(s),
  readPriorities = () => ({ priority: readBuildQueuePrioritySettings({ env }), buildPriority: readBuildPrioritySettings({ env }).ids, mainFix: readMainRedPriority({ env }) }),
  readMembership = ({ repo, num }) => readMergeQueueMembership({ repo, num, env }),
  timeoutMs = FAST_DRAIN_TIMEOUT_MS, readPr = ({ repo, num }) => readPrForWake({ repo, num, env }),
} = {}) {
  const misses = new Map();
  let pending = new Map();
  let running = null; // the serialized tick/catch-up promise
  let runningCatchUpOnly = false;
  let child = null;   // the in-flight fast drain (so the daemon can stop it when it exits)
  let lastLine = null;
  let lastCatchUpAt = null;
  let catchUpRoom = 0; // unspent drain attempts from the most recent queue snapshot
  let setting = ENQUEUE_ON_EVENT_DEFAULTS;
  const readSetting = () => {
    try { setting = resolveSetting(); } catch (e) { setting = { ...ENQUEUE_ON_EVENT_DEFAULTS, line: `enqueue-on-event: setting unreadable (${String(e?.message || e).split('\n')[0]}) — off` }; }
    if (setting.line && setting.line !== lastLine) { log(setting.line); lastLine = setting.line; }
    return setting;
  };
  readSetting();

  const catchUpDue = (s, t) => s.enabled && s.catchUp?.enabled &&
    (lastCatchUpAt === null || t - lastCatchUpAt >= s.catchUp.intervalMinutes * 60_000);

  async function runDue({ catchUpOnly = false } = {}) {
    const s = readSetting();
    if (!s.enabled) { pending = new Map(); return []; }
    let catchUpLater = [].values();
    let catchUpIndex = 0;
    const queueCatchUp = (num) => {
      const key = `${localSlug}#${num}`;
      if (pending.has(key)) return false;
      pending = new Map(pending).set(key, {
        // Keep the planned priority order through duePending, independently of ready-label churn.
        repo: localSlug, num, firstAt: now() + catchUpIndex++, lastAt: now() - s.debounceSeconds * 1000,
        causes: ['catch-up'], catchUp: true,
      });
      return true;
    };
    const refillCatchUp = () => {
      if ([...pending.values()].filter((p) => p.catchUp).length < catchUpRoom) {
        for (const num of catchUpLater) { if (queueCatchUp(num)) break; }
      }
    };
    if (catchUpDue(s, now()) && allowed()) {
      lastCatchUpAt = now();
      catchUpRoom = 0; // an unreadable queue cannot authorize retained work
      const result = await readCandidates({ repo: localSlug });
      if (!result.ok) log(`enqueue-on-event: catch-up could not list ready PRs (${result.error}) — retrying in ${s.catchUp.intervalMinutes} min`);
      else {
        const { capacity, source } = await readCapacity(s);
        catchUpRoom = Math.max(0, capacity - result.queued);
        const reserved = [...pending.values()].filter((p) => p.catchUp).length;
        const plan = planCatchUp({ ...result, capacity: capacity - reserved, ...await readPriorities(), repo: localSlug, now: now(), order: s.catchUp.order, pendingNums: [...pending.values()].map((p) => p.num) });
        const nums = (ps) => ps.map((n) => `#${n}`).join(' ');
        log(`enqueue-on-event: catch-up listed ${result.prs.length} ready-to-merge PR(s), ${result.queued} in the merge queue, room ${Math.max(0, capacity - result.queued)} (capacity ${capacity} from ${source}) — ${plan.run.length ? `fast drain for ${nums(plan.run.map((p) => p.num))} (${s.catchUp.order ?? 'priority-then-first-accept'})` : 'nothing to run'}${plan.later.length ? `; later: ${nums(plan.later)}` : ''}${plan.skipped.length ? `; skipped: ${plan.skipped.map((p) => `#${p.num} ${p.reason}`).join(', ')}` : ''}`);
        for (const { num } of plan.run) queueCatchUp(num);
        catchUpLater = plan.later.values();
      }
    }
    const ran = [];
    for (;;) {
      if (!allowed()) break;
      const [p] = duePending(pending, { now: now(), debounceSeconds: s.debounceSeconds })
        .filter((p) => (!catchUpOnly || p.catchUp) && (!p.catchUp || catchUpRoom > 0));
      if (!p) break;
      const key = `${p.repo}#${p.num}`;
      const taken = pending.get(key);
      const prefix = `enqueue-on-event: ${p.catchUp ? 'catch-up ' : ''}#${p.num}`;
      const metadata = p.catchUp ? { catchUp: true } : {};
      pending = new Map(pending); pending.delete(key);
      let pr = null;
      try { pr = await readPr({ repo: p.repo, num: p.num }); } catch { pr = null; }
      const w = wakeWorthy(pr);
      if (!w.wake) {
        log(`${prefix} ${taken.causes.join(', ')} — not woken: ${w.reason}`);
        ran.push({ ...metadata, num: p.num, code: null, what: `not woken: ${w.reason}` });
        // A skipped wake used no queue space: try the next candidate in priority order.
        if (p.catchUp) refillCatchUp();
        continue;
      }
      if (!allowed()) { pending = new Map(pending).set(key, taken); break; } // the window closed during the read
      const startedAt = now();
      const args = fastDrainArgs({ scriptRoot: scriptRoot(), num: p.num });
      if (p.catchUp) catchUpRoom--; // keep the bound across ticks and window closures; unknown results consume room
      log(`${prefix} ${taken.causes.join(', ')} — running the drain's single-PR fast drain ${Math.round((startedAt - taken.lastAt) / 1000)}s after the last event`);
      const r = await runChild({ args, cwd, env, spawnImpl, timeoutMs, onChild: (c) => { child = c; } });
      child = null;
      const json = lastJsonLine(r.stdout);
      let what = r.error ? `could not run (${r.error})` : summarizeFastDrain(json, p.num);
      const summary = what;
      let verified = null;
      let missed = what.startsWith('not enqueued:');
      if (what.startsWith('passed every drain gate — enqueued')) {
        let membership;
        try { membership = await readMembership({ repo: p.repo, num: p.num }); }
        catch (e) { membership = { ok: false, error: String(e?.message || e).split('\n')[0] }; }
        if (!membership?.ok) what += ` (unverified: ${membership?.error || 'membership unreadable'})`;
        else if (membership.inQueue) {
          verified = true;
          misses.delete(p.num);
          what += ` (verified: isInMergeQueue=true${membership.entry?.position != null ? `, position ${membership.entry.position}` : ''}${membership.entry?.state ? `, state ${membership.entry.state}` : ''})`;
        } else {
          verified = false;
          missed = true;
          const events = (membership.lastEvents || []).map(e => `${e.__typename}${e.createdAt ? ` at ${e.createdAt}` : ''}${e.reason ? `: ${e.reason}` : ''}`).join('; ') || 'no AddedToMergeQueue event';
          const stderr = String(r.stderrTail || '').replace(/\s+/g, ' ').trim().slice(-300);
          what = `NOT enqueued: the fast drain claimed enqueued but GitHub isInMergeQueue=false (${events}; fast-drain stderr: ${stderr}) — retrying on the next catch-up`;
        }
      }
      if (missed) {
        const count = (misses.get(p.num) || 0) + 1;
        misses.set(p.num, count);
        const threshold = s.catchUp?.missSmellAfter ?? ENQUEUE_ON_EVENT_DEFAULTS.catchUp.missSmellAfter;
        if (count % threshold === 0) log(`enqueue-on-event: SMELL enqueue-not-entering — #${p.num} missed the merge queue ${count} catch-up(s) in a row (last: ${what}); check the fast drain's enqueueOutcomes / adaptive batching state`);
      }
      if (p.catchUp && summary.startsWith('not enqueued: batching-deferred:')) {
        let dropped = 0;
        pending = new Map(pending);
        for (const [key, entry] of pending) if (entry.catchUp) { pending.delete(key); dropped++; }
        log(`enqueue-on-event: catch-up stopping this round — batching deferred #${p.num} (${summary.slice('not enqueued: batching-deferred:'.length).trim()}); ${dropped} PR(s) retried at the next catch-up`);
      } else if (p.catchUp && !r.error && fastDrainUsedNoRoom(json, p.num)) {
        catchUpRoom++;
        refillCatchUp();
      }
      log(`${prefix} fast drain exit ${r.code ?? 'none'} in ${Math.round((now() - startedAt) / 1000)}s — ${what}`);
      ran.push({ ...metadata, num: p.num, code: r.code, what, verified });
    }
    return ran;
  }

  function startRun(options, previous = null) {
    const promise = (previous ? previous.then(() => runDue(options), () => runDue(options)) : runDue(options))
      .finally(() => { if (running === promise) running = null; });
    running = promise;
    runningCatchUpOnly = options.catchUpOnly === true;
    return promise;
  }

  return {
    /** Fold one `consumer.pollOnce()` result in. */
    notePoll(r) { if (r?.ok !== false && Array.isArray(r?.marked) && r.marked.length) pending = notePending(pending, r.marked, { localSlug, now: now() }); },
    /** Run every due PR now (one at a time) if enabled and allowed; a no-op while a tick is already running. */
    tick() { return running && !runningCatchUpOnly ? running : startRun({}, running); },
    /** Serialize a catch-up-only opportunity after any in-flight run. */
    catchUp() { return startRun({ catchUpOnly: true }, running); },
    /** Resolves when no fast drain is in flight (call before a full pass or a clone refresh). */
    idle() { return running ? running.then(() => undefined, () => undefined) : Promise.resolve(); },
    /** Stop the in-flight fast drain (the daemon calls this on its own exit, like it stops its pass child). */
    kill() { if (child) { try { child.kill('SIGTERM'); } catch { /* gone */ } } },
    misses: () => new Map(misses),
    pending: () => [...pending.values()],
    setting: () => setting,
    lastCatchUpAt: () => lastCatchUpAt,
  };
}

// ── CLI: a foreground watch over the live feed (operator check / live proof) ─────────────────────────────────────
// node scripts/lib/enqueue-on-event.mjs watch --minutes=N   (needs WE_PR_EVENTS_URL + WE_PR_EVENTS_TOKEN_FILE; runs
// the fast drain from the current checkout, which must be a clean WE clone on main). Its own feed role, so it never
// moves the drain daemon's cursor.
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'watch') { console.log('usage: node scripts/lib/enqueue-on-event.mjs watch [--minutes=N]'); process.exitCode = 2; return; }
  const minutes = Number((rest.find((a) => a.startsWith('--minutes=')) || '--minutes=10').slice(10)) || 10;
  const { createFeedConsumerFromEnv } = await import('./pr-event-feed.mjs');
  const { localRepoSlug } = await import('../readiness/drain-lock.mjs');
  const { consumer, reason } = createFeedConsumerFromEnv({ role: 'enqueue-on-event-watch', log: { error: (m) => console.error(m) } });
  if (!consumer) { console.error(`enqueue-on-event: ${reason}`); process.exitCode = 1; return; }
  const cwd = process.cwd();
  const end = Date.now() + minutes * 60_000;
  const h = createEnqueueOnEvent({ cwd, localSlug: localRepoSlug({ cwd }), allowed: () => Date.now() < end, log: (m) => console.error(`${new Date().toISOString()} ${m}`) });
  while (Date.now() < end) {
    const r = await consumer.pollOnce();
    const eligible = (r.marked || []).filter((m) => isEligibleCause(m.cause));
    if (eligible.length) console.error(`${new Date().toISOString()} enqueue-on-event: feed ${eligible.map((m) => `${m.key} ${m.cause}`).join('; ')}`);
    h.notePoll(r);
    await h.tick();
    await new Promise((res) => { setTimeout(res, 5_000); });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exitCode = 1; });
}
