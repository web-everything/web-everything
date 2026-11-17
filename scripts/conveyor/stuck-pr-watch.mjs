#!/usr/bin/env node
/**
 * @file scripts/conveyor/stuck-pr-watch.mjs
 * @description THE STUCK-PR WATCH (epic #3383) — a standing, cross-repo mechanical pass that catches an open
 *   PR sitting with NO progress (no new commit, label event, or comment) for longer than the expected time for
 *   its review stage, with nothing live already working it, and launches ONE diagnosis-only inspection agent
 *   per stuck EPISODE. Operator (2026-09-23): "we also should have a health watch that launch and inspection
 *   if pr are stuck."
 *
 *   node scripts/conveyor/stuck-pr-watch.mjs sweep [--repo=<owner/name>] [--dry-run]
 *   node scripts/conveyor/stuck-pr-watch.mjs timeline --pr=<n> --repo=<owner/name>   (the inspection agent's
 *     GET-only timeline read — it is denied `gh api`; see {@link defaultReadFullTimeline})
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors `we:scripts/conveyor/parked-pr-conflict-watch.mjs` /
 * `we:scripts/conveyor/parked-pr-progress-watch.mjs`):
 *   • {@link ./stuck-pr-watch-core.mjs} decides stage, threshold, stuck-or-not, dispatch idempotency, and the
 *     concurrency cap — no fs/git/gh/clock.
 *   • This file owns every `gh`/`claude` call: the open-PR discovery, the per-candidate timeline fetch (lazy —
 *     paid only for a PR already narrowed to a tracked stage), the live-agents read (REUSED from
 *     `we:scripts/conveyor/reconcile-pass.mjs`, never re-derived — the same enrichment `assessLiveness` needs),
 *     the dispatch itself, and the marker comment.
 *
 * ONE INSPECTION PER STUCK EPISODE, NO SEPARATE STORE (#2612). The watch posts its OWN marker comment
 * ({@link buildStuckDispatchComment}) the instant it dispatches, embedding the exact `activityAt` timestamp
 * that made this episode stuck — {@link alreadyDispatchedForEpisode} reads it back off the PR's own comment
 * thread before ever dispatching again. This is why the marker is posted by THIS pass, not left to the
 * dispatched agent's own (separately-required) diagnostic comment: a fast tick cadence could otherwise dispatch
 * several inspection agents at the same PR before the first one ever got around to commenting.
 *
 * MARKER FIRST, THEN LAUNCH (PR #2553 review). The marker is the only record that an agent was launched, so it
 * is written BEFORE the launch: a failed comment launches nothing (the next sweep simply retries), instead of
 * leaving a live, unrecorded agent that the next sweep would duplicate. If the launch fails after the marker is
 * up AND the failure proves no agent started (`stuck-pr-inspect-dispatch.mjs#noInspectionStarted`), the watch
 * posts one retraction ({@link buildStuckDispatchRetractionComment}) that reopens the episode for one more try.
 * Any other launch failure (a timeout, a non-zero exit — the session may exist), a second failure, or a failed
 * retraction leaves the episode marked, so it goes uninspected until the PR's next real activity — the
 * at-most-once side of the trade, chosen over launching duplicates or commenting every sweep.
 *
 * CONCURRENCY CAP, ACROSS EVERY REPO. `we:scripts/conveyor/stuck-pr-watch-core.mjs#planStuckDispatches` is
 * called with the CURRENT count of live `inspect-*` sessions (any repo tag), so a per-repo invocation of this
 * CLI still respects one GLOBAL cap rather than N independent ones.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { createGhProvider } from '../lib/review-label-provider.mjs';
import { defaultReadAgents, enrichAgents } from './reconcile-pass.mjs';
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
import { parseSessionSlug } from './session-slug.mjs';
import { dispatchInspection, planInspectDispatch, noInspectionStarted } from './stuck-pr-inspect-dispatch.mjs';
import { writeAllSync, writeLineSync } from '../lib/write-all-sync.mjs';
import {
  isNeverStuckPr, classifyStuckStage, latestActivityAt, evaluateStuckPr, stuckThresholdMinutes,
  buildStuckDispatchComment, buildStuckDispatchRetractionComment, alreadyDispatchedForEpisode,
  stuckDispatchRetractions, MAX_RETRACTIONS_PER_EPISODE, planStuckDispatches, maxConcurrentInspections,
} from './stuck-pr-watch-core.mjs';

/** How many open PRs one `gh pr list` call reads per repo — matches the sibling watches' own limit. */
export const PR_LIST_LIMIT = 200;

/** The `--json` fields this pass reads about each open PR — every one load-bearing:
 *  `mergeable` (stage classification + the `conflict` stage itself), `labels` (every other stage),
 *  `isDraft`/`comments` (the never-stuck exclusions + the dispatch-marker idempotency), `headRefOid`
 *  (`bindAgents`'s own liveness binding), `headRefName` (report legibility). */
export const PR_LIST_JSON_FIELDS = 'number,headRefName,headRefOid,labels,mergeable,isDraft,comments';

/**
 * The open-PR discovery query. `exec` is injectable so the argv is assertable with no `gh` on PATH.
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultListOpenPrs({ exec = execFileSyncThrottled, repo = null } = {}) {
  // #gh-graphql-budget — read the host-shared open-PR snapshot (one right-sized list per repo per TTL for the
  // whole fleet) instead of a private `gh pr list`; null = not applicable (tests, cwd repo) → the direct read below.
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: PR_LIST_JSON_FIELDS }); if (shared) return shared; }
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_JSON_FIELDS];
  if (repo) argv.push('--repo', repo);
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * THE LAZY, PER-CANDIDATE timeline fetch (paid only for a PR already narrowed to a tracked stage — see
 * `isParkedCandidate`'s own docblock in `we:scripts/conveyor/parked-pr-progress-watch.mjs` for the identical
 * cost-avoidance shape). GitHub's issue-events/timeline endpoint carries every `labeled`/`commented`/`committed`
 * event (among others) for a PR; `--jq` projects only the three this watch treats as progress. A commit event's
 * own timestamp rides `committer.date`/`author.date`, not `created_at` (unlike a label or comment event) — the
 * `//` fallback chain covers all three shapes in one query. A comment event also carries the head of its `body`
 * (enough to read its leading line) so the pure core can tell the watch's OWN writes from real progress (PR
 * #2553 review) — one compact JSON object per line, since a body may hold tabs/newlines a TSV row cannot.
 * @param {{number:number|string, repo?:string|null, exec?:Function}} o
 * @returns {Array<{createdAt:string, event:string, body?:string}>}
 */
export function defaultListTimelineEvents({ number, repo, exec = execFileSyncThrottled } = {}) {
  const path = repo ? `repos/${repo}/issues/${number}/timeline` : `repos/{owner}/{repo}/issues/${number}/timeline`;
  const argv = ['api', '--paginate', '-X', 'GET', '-F', 'per_page=100', path,
    '--jq', '.[] | select(.event=="labeled" or .event=="commented" or .event=="committed") | '
      + '{createdAt: (.created_at // .committer.date // .author.date // ""), event: .event, '
      + 'body: (if .event=="commented" then ((.body // "") | .[0:200]) else null end)} | @json'];
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const { createdAt, event, body } = JSON.parse(line);
    return typeof body === 'string' ? { createdAt, event, body } : { createdAt, event };
  });
}

/**
 * THE INSPECTION AGENT'S TIMELINE READ (PR #2553 review). The dispatched inspection agent is denied `gh api`
 * wholesale (raw REST reaches every write its per-verb deny rules cover — see
 * `we:scripts/conveyor/stuck-pr-inspect-dispatch.mjs#INSPECT_DISPATCH_DISALLOWED_TOOLS`), yet its brief needs the
 * PR's full timeline. This is that read with a FIXED argv: always `-X GET`, no caller-supplied method, fields,
 * or input — so it can never become a write. Projects every event (not just the three progress types) with its
 * actor, label, and the head of a comment's body — enough to diagnose a stall.
 * @param {{number:number|string, repo:string, exec?:Function}} o
 * @returns {Array<{event:string, createdAt:string, actor:string|null, label:string|null, body:string|null}>}
 */
export function defaultReadFullTimeline({ number, repo, exec = execFileSyncThrottled } = {}) {
  const num = Number(number);
  if (!Number.isInteger(num) || num <= 0) throw new Error(`timeline: --pr must be a positive integer, got ${JSON.stringify(number)}`);
  if (repoKeyForSlug(String(repo ?? '')) === null) throw new Error(`timeline: --repo ${repo} is not a constellation repo`);
  const argv = ['api', '--paginate', '-X', 'GET', '-F', 'per_page=100', `repos/${repo}/issues/${num}/timeline`,
    '--jq', '.[] | {event: (.event // ""), createdAt: (.created_at // .submitted_at // .committer.date // .author.date // ""), '
      + 'actor: ((.actor // .user // {}).login // null), label: (.label.name // null), '
      + 'body: (if (.body | type) == "string" then .body[0:500] else null end)} | @json'];
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return String(out || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * How many `inspect-*` sessions (any repo tag) are LIVE right now, for the global concurrency cap. A read
 * failure refuses counting: unseen inspections never create free capacity. The sweep
 * defers dispatch until discovery can be repaired and retried.
 * @param {{listAgents?:Function}} [o]
 * @returns {number}
 */
export function defaultCountLiveInspections({ listAgents = () => defaultListAgents({}) } = {}) {
  const rows = listAgents(); // SessionsUnknown must propagate to the concurrency gate.
  if (!Array.isArray(rows) || rows.incomplete?.length) throw new Error('inspection discovery unknown');
  const agents = [...new Map(rows.map(a => [JSON.stringify([a.storeKey, a.sessionId ?? a.id ?? a.name]), a])).values()];
  const identities = new Set();
  for (const agent of agents) {
    if (!agent.sessionId) continue;
    if (identities.has(agent.sessionId)) throw new Error('inspection ownership ambiguous');
    identities.add(agent.sessionId);
  }
  return agents.filter(a => parseSessionSlug(a?.name)?.kind === 'inspect').length;
}

/**
 * THE IO SHELL. Lists open PRs, narrows to tracked-stage candidates, fetches each candidate's own timeline
 * lazily, decides stuck-ness (reusing the live-agent binding — never re-derived), applies the per-episode
 * dispatch idempotency and the concurrency cap, and dispatches + comments on whatever survives. Never throws on
 * a per-PR read/write failure — mirrors every sibling watch's own best-effort contract.
 * @param {object} [o]
 * @returns {{checked:number, stuck:number, dispatchedCount:number, results:Array<object>}}
 */
export function watchStuckPrs({
  repo = null, dryRun = false, now = Date.now(), env = process.env, thresholds, maxConcurrent,
  listPrs = defaultListOpenPrs, listTimelineEvents = defaultListTimelineEvents,
  readAgents = defaultReadAgents, enrich = enrichAgents,
  countLiveInspections = defaultCountLiveInspections,
  provider = createGhProvider(), dispatch = dispatchInspection,
} = {}) {
  const repoKey = repo == null ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`stuck-pr-watch: --repo ${repo} is not a constellation repo`);
  const thresholdsResolved = thresholds ?? stuckThresholdMinutes(env);
  const cap = maxConcurrent ?? maxConcurrentInspections(env);

  const prs = listPrs({ repo });
  let agents = [];
  try {
    agents = enrich(readAgents({}));
  } catch (e) {
    // A failed agents read must fail CLOSED for every candidate this tick — never guess "nothing live" from an
    // unreadable listing (the same bias `we:scripts/conveyor/parked-pr-progress-watch.mjs` already applies to
    // its own agents read).
    writeLineSync(2, `⚠ stuck-pr-watch: could not read agents listing, skipping this sweep: ${String((e && e.message) || e).split('\n')[0]}`);
    return { checked: Array.isArray(prs) ? prs.length : 0, stuck: 0, dispatchedCount: 0, results: [] };
  }

  const results = [];
  const candidates = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    const num = pr?.number;
    if (isNeverStuckPr(pr)) { results.push({ num, verdict: 'excluded' }); continue; }
    const stage = classifyStuckStage(pr);
    if (!stage) { results.push({ num, verdict: 'no-tracked-stage' }); continue; }

    let activityAt = null;
    try {
      activityAt = latestActivityAt(listTimelineEvents({ number: num, repo }));
    } catch (e) {
      results.push({ num, stage, verdict: 'activity-unknown', error: String((e && e.message) || e).split('\n')[0] });
      continue;
    }

    const verdict = evaluateStuckPr({ pr, agents, repo: repoKey, now, thresholds: thresholdsResolved, activityAt });
    if (!verdict.stuck) { results.push({ num, ...verdict }); continue; }
    if (alreadyDispatchedForEpisode(pr?.comments, activityAt)) {
      results.push({ num, ...verdict, verdict: 'already-dispatched-this-episode' });
      continue;
    }
    candidates.push({
      pr, num, stage: verdict.stage, minutesSince: verdict.minutesSince, thresholdMinutes: verdict.thresholdMinutes,
      activityAt: verdict.activityAt,
    });
  }

  let liveInspectCount;
  try {
    liveInspectCount = countLiveInspections({});
    if (!Number.isFinite(liveInspectCount) || liveInspectCount < 0) throw new Error('inspection count unknown');
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0];
    writeLineSync(2, `⚠ stuck-pr-watch: inspection capacity unknown; repair discovery and retry: ${reason}`);
    for (const c of candidates) results.push({ num: c.num, stage: c.stage, verdict: 'stuck', deferredReason: 'inspection-capacity-unknown' });
    return { checked: Array.isArray(prs) ? prs.length : 0, stuck: candidates.length, dispatchedCount: 0, results };
  }
  const { toDispatch, deferred } = planStuckDispatches({ candidates, liveInspectCount, maxConcurrent: cap });

  for (const c of deferred) {
    results.push({
      num: c.num, stage: c.stage, minutesSince: c.minutesSince, thresholdMinutes: c.thresholdMinutes,
      activityAt: c.activityAt, verdict: 'stuck', deferredReason: c.deferredReason,
    });
  }

  const dispatched = [];
  let resolvedRepo = repo;
  for (const c of toDispatch) {
    const base = {
      num: c.num, stage: c.stage, minutesSince: c.minutesSince, thresholdMinutes: c.thresholdMinutes,
      activityAt: c.activityAt, verdict: 'stuck',
    };
    if (dryRun) { results.push({ ...base, wouldDispatch: true }); continue; }
    // Marker first, then launch — see the file header. Nothing is launched until the marker is on the PR.
    let markerPosted = false;
    try {
      if (resolvedRepo == null) resolvedRepo = provider.currentRepo();
      const { sessionSlug } = planInspectDispatch({ pr: c.num, repo: resolvedRepo });
      provider.postComment(resolvedRepo, c.num, buildStuckDispatchComment({
        stage: c.stage, minutesSince: c.minutesSince, thresholdMinutes: c.thresholdMinutes,
        activityAt: c.activityAt, sessionSlug,
      }));
      markerPosted = true;
      const d = dispatch({
        pr: c.num, repo: resolvedRepo, stage: c.stage, minutesSince: c.minutesSince, thresholdMinutes: c.thresholdMinutes,
      });
      dispatched.push({ num: c.num, sessionSlug: d.sessionSlug, agentId: d.agentId });
      results.push({ ...base, dispatched: true, sessionSlug: d.sessionSlug, agentId: d.agentId });
    } catch (e) {
      const error = String((e && e.message) || e).split('\n')[0];
      // Reopen the episode ONLY when the failure proves no agent exists (anything else may have started one),
      // and only once per episode (a failure that repeats every sweep must not post comments forever).
      const mayRetract = markerPosted && noInspectionStarted(e)
        && stuckDispatchRetractions(c.pr?.comments, c.activityAt) < MAX_RETRACTIONS_PER_EPISODE;
      let retracted = false;
      if (mayRetract) {
        try {
          provider.postComment(resolvedRepo, c.num, buildStuckDispatchRetractionComment({ activityAt: c.activityAt }));
          retracted = true;
        } catch { /* at-most-once: the episode stays marked, so nothing is ever launched twice for it */ }
      }
      results.push({ ...base, error, ...(markerPosted ? { retracted } : {}) });
    }
  }

  return {
    checked: Array.isArray(prs) ? prs.length : 0,
    stuck: candidates.length,
    dispatchedCount: dispatched.length,
    results,
  };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => (argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || undefined;
  const verb = argv.find((a) => !a.startsWith('--')) || 'sweep';
  const repo = flag('repo') || null;
  const dryRun = argv.includes('--dry-run');
  const prsFile = flag('prs-file');
  if (verb === 'timeline') {
    try {
      writeAllSync(1, `${JSON.stringify(defaultReadFullTimeline({ number: flag('pr'), repo }))}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  } else if (verb !== 'sweep') {
    writeLineSync(2, 'usage: stuck-pr-watch.mjs sweep [--repo=<owner/name>] [--dry-run] [--prs-file=<path>]\n'
      + '       stuck-pr-watch.mjs timeline --pr=<n> --repo=<owner/name>   (read-only, GET-only)');
    process.exitCode = 2;
  } else {
    try {
      const result = watchStuckPrs({ repo, dryRun, ...(prsFile ? { listPrs: () => readPrsFromFile(prsFile) } : {}) });
      for (const r of result.results) {
        if (r.verdict !== 'stuck') continue;
        const tail = r.wouldDispatch ? 'would dispatch an inspection agent'
          : r.dispatched ? `dispatched inspection (${r.sessionSlug}${r.agentId ? `, agent ${r.agentId}` : ''})`
            : r.deferredReason ? `deferred (${r.deferredReason})`
              : r.error ? `FAILED to dispatch (${r.error})` : 'stuck';
        writeLineSync(2, `  ⚠ PR #${r.num}: ${tail} — stage=${r.stage}, ~${Math.round(r.minutesSince)}m since last activity (threshold ${r.thresholdMinutes}m, last activity ${r.activityAt})`);
      }
      writeAllSync(1, `${JSON.stringify(result)}\n`);
    } catch (e) {
      writeLineSync(2, `error: ${String(e?.message ?? e)}`);
      process.exitCode = 1;
    }
  }
}
