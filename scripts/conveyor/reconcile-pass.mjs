/**
 * reconcile-pass.mjs — the thin IO shell around `we:scripts/conveyor/reconcile-core.mjs` (#3296): read the four
 * facts the pure pass needs, run it, and REPORT every dispatch and every refusal.
 *
 * A ONE-SHOT PASS, NOT A RESIDENT PROCESS. It reads, decides, prints and exits — the shape
 * `we:scripts/converge-daemon-pass.mjs` already argues for ("a `StartInterval` job is the whole daemon, and it
 * costs one plist"). Folding this into the conveyor tick was REFUSED on the evidence: that tick's bookkeeping
 * (`launchedNums`, `fixGuards`, `watched`) is piped in over STDIN and is session-ephemeral by construction, so a
 * reconciler living inside it would forget every PR the moment the session that launched them exited — which is
 * the exact defect being fixed, reintroduced one level down.
 *
 * WHAT THIS FILE ADDS, AND ALL IT ADDS: the impure facts the core cannot read.
 *   1. The open PRs — `gh pr list --state open --json number,headRefName,headRefOid,labels,statusCheckRollup,
 *      mergeStateStatus,comments`.
 *   2. The live sessions — `claude agents --json`, via `defaultListAgents`
 *      (`we:scripts/operations/dispatch-lane-io.mjs`), REUSED rather than rebuilt so the two callers can never
 *      ask the tool different questions.
 *   3. `laneHeadOid` per session — `git -C <cwd> rev-parse HEAD`. The listing carries no `pr`, `item`, `num`,
 *      `branch` or `ref` field on any entry (measured over all 17 live sessions), so the PR↔session binding must
 *      be derived, and this is the only derivation available today. It is a PROXY and it has been observed to be
 *      wrong (#3283), which is why the core carries the `cwd` and `sha` out to every liveness refusal.
 *   4. `pidAlive` per session — `process.kill(pid, 0)`. A `pid` is on only 13 of 17 entries; where it is absent
 *      this stays UNDEFINED and the core refuses as `liveness-unknown`. It must never be defaulted to `false`:
 *      absence of a field is not evidence of death.
 *   5. we:backlog/x5uqim1-*.md (#4075/#3383) — `main`'s own red-CI windows (`gh run list --branch main`) plus,
 *      per PR whose required check is currently failing, that check's own completion time and how far behind
 *      `main`'s current tip its head is (`gh api .../compare`'s own `ahead_by`, {@link enrichPrsWithMainRedFacts}).
 *      Read ONLY when at least one PR is failing, so a quiet pass pays nothing for it. Lets the core tell a
 *      required check that failed only because `main` itself was red apart from the PR's own defect
 *      (`reconcile-core.mjs#isPrCiFailureOwedRerun`), so it is never handed to a `ci-heal`.
 *
 * WHY THE ARGV IS PINNED BY A TEST AND NOT MERELY EXERCISED. The failure mode of a wrong discovery query is
 * SILENCE, not an error: an empty listing is indistinguishable from "no PR needs anything", so a query that
 * matches nothing looks exactly like a perfectly reconciled fleet. Every other case in
 * `reconcile-core.test.mjs` passes on injected fixtures and would stay green while this pass reconciled nothing
 * in production. `--state open` is the load-bearing flag here, and it is deliberately NOT the `--state all` that
 * `we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs` pins for a different reader: that reader
 * resolves on MERGED PRs, this one reconciles OPEN ones, and copying the flag across would hide every PR this
 * pass exists to see. `headRefOid` is load-bearing for the same reason — without it the liveness binding has
 * nothing to compare a lane `HEAD` against, and every PR would read as unowned.
 *
 * IT DISPATCHES NOTHING ITSELF. The pass decides that a fix or a review is OWED and reports it; spawning the
 * independent reviewer is #3279's operation and running the review loop is #3072. Emitting a plan a caller acts
 * on keeps this pass a READ, which is what makes it safe to run on an interval.
 *
 * SINGLETON-LEASED THE WAY `we:scripts/review-runner.mjs` LEASES — the lease belongs to whatever schedules this
 * (the plist / the conveyor), not to the read itself, and is NOT taken here: two concurrent reads of a PR list
 * cannot corrupt anything, and a lease taken inside a one-shot read is a lease nothing releases when the process
 * is killed.
 */
import { fetchPrCommits } from '../lib/pr-limit.mjs';
import { collapseRollupToLatestPerName } from '../lib/rollup-collapse.mjs';
import { FAILING_CONCLUSIONS, NON_BLOCKING_CONCLUSIONS, reduceCheckState } from '../operations/pr-status.mjs';
import { checksArgv, parseJsonLines, GH_TIMEOUT_MS } from '../operations/pr-status-io.mjs';
import { isGhDeferred } from '../lib/gh-deferred.mjs';
import { readTimeoutBudget } from './timeout-retry-state.mjs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { createRequire } from 'node:module';
import { repoKeyForSlug, CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
// #2748 false-red follow-up (soak-replay-gate, PR #2775) — the repo's REQUIRED status-check names, live +
// cached (`we:scripts/lib/required-status-checks.mjs`), so `planReconcile`'s `ci-red` branch means a REQUIRED
// check failed rather than "any check outside a hand-maintained exclusion list" — see that module's own header
// for the full incident this closes. Anchored at the TOP of the import block (rather than beside the other
// `reconcile-core.mjs`-adjacent imports below) so it never collides with an overlay editing that region.
import { getRequiredStatusChecks } from '../lib/required-status-checks.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { readSharedOpenPrs } from '../lib/pr-snapshot.mjs';
import { readPrsFromFile } from './open-pr-fetch.mjs';
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
import { listAgentsWithReviewJobs } from '../operations/review-job-store.mjs';
import { countRearmComments } from './rearm-review.mjs';
import { planReconcile, DISPATCH_KINDS, REFUSAL_KINDS, markSelfReportedDone, markHungSessions, markAuthExpiredSessions, markIdleFinishedSessions, markBgIsolationStalls } from './reconcile-core.mjs';
import { tryReadCompletion } from '../operations/completion-store.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
// we:backlog/x5uqim1-*.md (#4075/#3383) — the two extra facts `reconcile-core.mjs#isPrCiFailureOwedRerun` needs
// per `ci-red` PR, plus `main`'s own red windows. `latestRequiredCheck`/`isRequiredCheckFailed` are REUSED from
// `we:scripts/merge-ai-prs.mjs` (never re-derived) — the same collapsed-rollup reader every other required-check
// consumer in this repo already shares.
import { latestRequiredCheck, isRequiredCheckFailed } from '../merge-ai-prs.mjs';
import {
  computeMainRedWindows, DEFAULT_MAIN_WORKFLOW_NAME, DEFAULT_REQUIRED_CHECK, DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS,
  failingRequiredCheckForAttribution, isAnyRequiredCheckFailed,
  // landing-freeze fix (2026-09-27) — the one extra read `isPrCiFailureOwedRerun`'s new green-check path needs:
  // `main`'s own latest completed run's headSha, so the IO shell can fetch THAT commit's own per-check
  // conclusions. See `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header for the incident.
  latestCompletedMainRun,
  // PR #2793 review — the per-PR evidence the green-check path now also requires (see `isMainGreenFixOwed`).
  mainLatestGreenShaForCheck,
} from './main-red-recovery.mjs';
import { readHungInfo, resolveHungThresholdMs, readClaudeAuthExpiredInfo, readIdleFinishedInfo, resolveIdleFinishedThresholdMs } from './hung-session.mjs';
import { readBgIsolationStallInfo } from './bg-isolation-stall.mjs';
// #4263 — the pure escalation reader (no fs/network of its own) reconcile-core.mjs already imports; re-scanning
// comments HERE with the SAME function, never a re-derived copy, is what lets this enrich step find exactly the
// `systemFixRef` PRs reconcile-core.mjs's own escalation branch will independently re-derive from the same data.
import { latestCiHealEscalationForHead } from './ci-heal-escalation-mark.mjs';
import { readLiveFixClaim } from './fix-procedure.mjs';
import { enrichPrsWithReferralHolds } from './review-referral-hold.mjs';
import { ignoredRulings } from '../lib/ruling-ledger.mjs';
import { loadFixerLadder } from './fixer-ladder.mjs';

/** A confirmed finding the operator already ruled `block` on an earlier head that came back on this one (read off
 *  the PR thread alone, so a daemon restart loses nothing). Never throws: an unreadable thread means no claim. */
export function enrichPrsWithIgnoredRulings(prs, { humanAt } = {}) {
  return prs.map((pr) => {
    try { return { ...pr, ignoredRulings: ignoredRulings(pr, humanAt === undefined ? {} : { humanAt }) }; } catch { return { ...pr, ignoredRulings: null }; }
  });
}
// #4263 — the SAME terminal-state classifier `pr-watch.mjs`'s own drain-lane watcher uses (merged/closed/
// parked/pending), reused rather than re-invented so "has this PR landed" can never drift between the two
// call sites. Aliased: this file never reconciles a PR's PHASE (that word means something else here — see
// `classifyPr` imported from `progress-board.mjs` inside `reconcile-core.mjs`).
import { classifyPr as classifyPrLifecycle } from './pr-watch.mjs';

/**
 * we:scripts/conveyor/reconcile-pass.mjs#PR_LIST_JSON_FIELDS — the `--json` fields this pass reads about each
 * open PR. Named once so the test can assert the literal query and a dropped field reddens rather than going
 * quiet. Every one is load-bearing:
 *   `number`            — THE KEY. This pass is keyed by PR number, never item number (all four open head refs
 *                         measured today return `null` from `laneRefItemNum`).
 *   `headRefName`       — human evidence on every row, so a reader can find the branch.
 *   `headRefOid`        — the liveness binding compares it against a lane's `HEAD`. Without it nothing binds.
 *   `labels`            — what `classifyPr` reads for the phase.
 *   `statusCheckRollup` — what `classifyPr` and `reduceCheckState` read for CI truth.
 *   `mergeStateStatus`  — what `classifyPr` reads to spot a conflicted / behind branch.
 *   `comments`          — the durable thread: the findings count, the re-arm count, and the stand-down marker
 *                         all come off it. Dropping it silently zeroes all three.
 *   `body`              — `#xu2krte` Fork 1: `we:scripts/conveyor/reconcile-fix-dispatch.mjs` reads the PR's own
 *                         `authored-by-actor` stamp off it to find a conflict-caused bounce's original builder
 *                         session, for the opt-in resume-preference dispatch. Unused by every other decision.
 *   `baseRefName`       — #3383: what `reconcile-core.mjs`'s STACKED-BASE CONFLICT branch compares against
 *                         `defaultBranch` to tell a PR stacked on another lane/PR (the drain will never land it,
 *                         whatever its labels say) apart from an ordinary conflict against `main`. Dropping it
 *                         silently sends every `conflicted` PR back through the pre-#3383 `owed-elsewhere` path.
 *   `files`             — #x9fbg1x-live-incident (2026-09-27): the PR's own already-changed files, carried on
 *                         every row (evidence, mirrors `body`) so `reconcile-fix-dispatch.mjs#planFixesFromReconcile`
 *                         can fence a no-declared-scope fix dispatch off the PR's REAL diff without a second,
 *                         separate `gh pr diff` call of its own (previously the ONLY way that fallback could
 *                         read the PR's files — see that file's own docblock for the live PR #2779 this fixes:
 *                         a genuine, rich diff silently read as empty whenever that separate call failed).
 *                         Costs nothing extra beyond this one query already paying for connection fields
 *                         (`labels`/`statusCheckRollup`/`comments`) — `files` is the same shape of field.
 */
// `isDraft` (draft-first PRs, operator-approved 2026-09-27) — the ONLY field this pass reads to tell a
// held-for-review draft apart from a ready-for-review one; `reconcile-core.mjs#planReconcile` reads it
// straight off each row (`pr.isDraft`) to gate review dispatch off drafts and to plan the `promote-draft`
// effect once a draft's required checks are green. Costs nothing extra beyond this one query, same as `files`
// above.
export const PR_LIST_JSON_FIELDS = 'number,headRefName,headRefOid,baseRefName,labels,statusCheckRollup,mergeStateStatus,comments,body,files,isDraft,createdAt';

/** How many open PRs one pass reads. The board's own `OPEN_LIMIT` is 30; a reconciler that silently stopped at
 *  the default page would leave the overflow unowned, which is this item's defect wearing a smaller hat. */
export const PR_LIST_LIMIT = 200;

/** Attach authorship only where the open-PR listing has no review disposition. */
export function enrichPrsWithReviewEvidence(prs, { repo, readCommits = fetchPrCommits } = {}) {
  return prs.map(pr => {
    if (!Array.isArray(pr.labels) || pr.labels.some(l => (typeof l === 'string' ? l : l?.name)?.startsWith('review:'))) return pr;
    return { ...pr, state: pr.state ?? 'OPEN',
      commits: readCommits(repo, pr.number, { headRefName: pr.headRefName, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName }) };
  });
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadPrs — the OPEN-PR discovery query. `exec` is injectable so
 * the argv is assertable with no `gh` on PATH and no credential.
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function defaultReadPrs({ exec = execFileSyncThrottled, repo = null, readCommits = fetchPrCommits, attributionRepo = repo } = {}) {
  const enrich = rows => enrichPrsWithReviewEvidence(rows, { repo: attributionRepo, readCommits: (slug, number, opts) => readCommits(slug, number, { ...opts, ...(exec !== execFileSyncThrottled ? { exec: args => exec('gh', args) } : {}) }) });
  // #gh-graphql-budget — read the host-shared open-PR snapshot (one right-sized list per repo per TTL for the
  // whole fleet) instead of a private `gh pr list`; null = not applicable (tests, cwd repo) → the direct read below.
  if (exec === execFileSyncThrottled) { const shared = readSharedOpenPrs({ repo, fields: PR_LIST_JSON_FIELDS, allowDeferred: true }); if (shared) return Array.isArray(shared) ? enrich(shared) : shared; }
  const argv = ['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', PR_LIST_JSON_FIELDS];
  if (repo) argv.push('--repo', repo);
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    throttle: { deferrable: true }, // this reader checks isGhDeferred below
  });
  if (isGhDeferred(out)) return JSON.parse(String(out));
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? enrich(parsed) : [];
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadAgents — the live-session listing. A THIN DELEGATION to
 * `defaultListAgents` (`we:scripts/operations/dispatch-lane-io.mjs`), not a second builder of the same argv: one
 * caller asking `claude agents --json` a different way than another is precisely the drift that makes two halves
 * of one chain disagree about what is alive.
 * ALSO runs {@link markHungSessions} (epic #3383 continuation) after the self-reported-done pre-pass, so a
 * session neither `state: 'done'` nor self-reported but whose OWN transcript file has gone stale (per
 * `we:scripts/conveyor/hung-session.mjs`) also stops reading as `live-process` in {@link
 * planReconcile}/`assessLiveness` — the mechanical backstop for exactly the case a crashed review agent's
 * unreported infra failure leaves behind (`review-agent-brief.md`'s "report done on exit" is prose, and prose
 * is not guaranteed to run).
 * THEN runs {@link markAuthExpiredSessions} (live incident, night of 2026-09-25/26 ET) after that, so a
 * session whose OWN transcript shows the Claude CLI's own auth-failure (see that function's own doc for the
 * full incident) ALSO stops reading as `live-process` — this one catches the failure the INSTANT it shows in
 * the transcript, rather than waiting out the generic hung-transcript threshold.
 * FINALLY (both epic #3383/#4075) runs {@link markIdleFinishedSessions} (live incident PR #2724, 2026-09-26)
 * — a backstop for EVERY kind, not only the ones with a completion-record schema: a session whose last
 * assistant turn has genuinely ENDED (no pending tool call) and has sat idle past a short threshold is
 * treated as finished, in case a brief forgets to report its own completion the way `fix-agent-ci-brief.md`
 * did — AND {@link markBgIsolationStalls} (#x9fbg1x, live incident `fix-2748`/`fix-2770`, 2026-09-26), which
 * gives a session `assessLiveness` already reports `awaiting-permission` a MORE SPECIFIC reason when its own
 * transcript shows Claude Code's own background-session worktree-isolation guard refusal — see
 * `we:scripts/conveyor/bg-isolation-stall.mjs`'s own header. Cheap: it reads a transcript only for a session
 * already classified `awaiting-permission`, never for the common live/finished case.
 * @param {{exec?:Function, env?:object, completionFor?:Function, hungInfoFor?:Function, authExpiredInfoFor?:Function, idleFinishedInfoFor?:Function, bgIsolationStallInfoFor?:Function, now?:number, hungThresholdMs?:number, idleFinishedThresholdMs?:number, listJobs?:Function}} [o]
 *   `listJobs` (x26lw6u) defaults to the live review-job rows; a test injects `() => []` or fakes.
 * @returns {Array<object>}
 */
export function defaultReadAgents({
  exec = execFileSync, env = process.env, completionFor = tryReadCompletion,
  hungInfoFor = readHungInfo, now = Date.now(), hungThresholdMs = resolveHungThresholdMs(env),
  authExpiredInfoFor = readClaudeAuthExpiredInfo,
  idleFinishedInfoFor = readIdleFinishedInfo, idleFinishedThresholdMs = resolveIdleFinishedThresholdMs(env),
  bgIsolationStallInfoFor = readBgIsolationStallInfo,
  listJobs = undefined,
} = {}) {
  // x26lw6u — a review now runs as a JOB (`we:scripts/operations/review-job.mjs`), not a `claude --bg` session,
  // so it has no listing row of its own. Its live job record is merged in as a row of the same shape (name
  // `review-<pr>`, `state: 'working'`, `pid`) — `bindAgents` then binds it by name and `assessLiveness` reads its
  // pid, so a PR with a review job in flight is refused `live-process` exactly as a live review session was.
  const listed = listAgentsWithReviewJobs({ listAgents: () => defaultListAgents({ exec, env }), listJobs });
  // xpb0zyq — a session that already wrote its own completion record is finished, whatever the listing says.
  const selfReported = markSelfReportedDone(Array.isArray(listed) ? listed : [], completionFor, now);
  // #3383 continuation — a session whose OWN transcript has gone stale is finished too, self-report or not.
  const hungMarked = markHungSessions(selfReported, hungInfoFor, now, hungThresholdMs);
  // Live incident fix, night of 2026-09-25/26 ET — a session whose OWN transcript shows the Claude CLI's own
  // auth failure is finished too, whatever the listing's `state`/pid say.
  const authMarked = markAuthExpiredSessions(hungMarked, authExpiredInfoFor);
  // #4075/xg7m2wq, live incident PR #2724, 2026-09-26 — the general backstop for EVERY kind: a session whose
  // last assistant turn has fully ended (no pending tool call) and has sat idle past a short threshold is
  // finished too, in case its own brief forgot to report completion the way `fix-agent-ci-brief.md` did.
  const idleMarked = markIdleFinishedSessions(authMarked, idleFinishedInfoFor, now, idleFinishedThresholdMs);
  // #x9fbg1x — LAST: only ever adds a clearer reason to a row already `awaiting-permission`, so running it
  // after every other pre-pass (which can only ever REMOVE a session from `live-process` contention, never add
  // `awaiting-permission`) is safe regardless of ordering.
  return markBgIsolationStalls(idleMarked, bgIsolationStallInfoFor);
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#resolveLaneHead — `git -C <cwd> rev-parse HEAD`, or `null`.
 *
 * FAILS TO `null`, NEVER TO A GUESS. A cwd that is not a git checkout, was deleted under a live session, or is
 * simply unreadable produces `null`, and `bindAgents` then binds NOTHING for that session. That direction is the
 * safe one only because of what sits behind it: an unbound session cannot suppress a dispatch, and a PR that is
 * genuinely being worked will still be caught by any OTHER session bound to it. The unsafe direction would be
 * defaulting to a sha, which would bind arbitrary sessions to arbitrary PRs.
 * @param {string} cwd
 * @param {Function} [exec]
 * @returns {string|null}
 */
export function resolveLaneHead(cwd, exec = execFileSync) {
  if (!cwd) return null;
  try {
    const out = exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    });
    const sha = String(out || '').trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#probePid — `process.kill(pid, 0)`, three-valued.
 *
 * `true` = the process exists. `false` = it provably does not (`ESRCH`). `null` = THE QUESTION COULD NOT BE
 * ASKED — no `pid` on the entry (4 of 17 today), a non-integer, or `EPERM` (the process exists but belongs to
 * another user, which is emphatically not death). `null` reaches the core as UNKNOWN and refuses. Defaulting any
 * of these to `false` would report a live agent as idle and hand its lane to a second one.
 * @param {*} pid
 * @param {Function} [kill]
 * @returns {boolean|null}
 */
export function probePid(pid, kill = (p, s) => process.kill(p, s)) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === 'ESRCH') return false;
    if (e && e.code === 'EPERM') return true; // it exists; it just is not ours to signal.
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#enrichAgents — attach the two facts the listing cannot carry
 * (`laneHeadOid`, `pidAlive`) to each session entry, leaving every field the tool DID return untouched.
 *
 * `pidAlive` is OMITTED, not set to `null`, when the probe could not answer — an absent key and an explicit
 * `null` mean the same thing to the core (`!== false` ⇒ unknown), and omitting keeps the enriched record a
 * faithful superset of what `claude agents --json` actually returned.
 * @param {Array<object>} agents
 * @param {{readLaneHead?:Function, probe?:Function}} [io]
 * @returns {Array<object>}
 */
export function enrichAgents(agents, { readLaneHead = resolveLaneHead, probe = probePid } = {}) {
  const headCache = new Map();
  return (Array.isArray(agents) ? agents : []).map((a) => {
    const cwd = String(a?.cwd ?? '');
    if (cwd && !headCache.has(cwd)) headCache.set(cwd, readLaneHead(cwd));
    const alive = probe(Number.isInteger(a?.pid) ? a.pid : null);
    return {
      ...a,
      laneHeadOid: cwd ? headCache.get(cwd) : null,
      ...(alive === null ? {} : { pidAlive: alive }),
    };
  });
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#durableCountsFrom — the restart-surviving attempt count per PR, read
 * back off each PR's own comment thread with `countRearmComments`. The count IS PR state; no parallel store
 * exists and none is created (#2612).
 * @param {Array<object>} prs
 * @returns {object} `{ [prNumber]: n }`
 */
export function durableCountsFrom(prs) {
  const out = {};
  for (const pr of Array.isArray(prs) ? prs : []) {
    const n = Number(pr?.number);
    if (Number.isInteger(n) && n > 0) out[n] = countRearmComments(pr?.comments);
  }
  return out;
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadMainRuns — `main`'s own recent run history for one
 * workflow, the ONE read `we:scripts/conveyor/main-red-recovery.mjs#computeMainRedWindows` needs. `exec` is
 * injectable so the argv is assertable with no `gh` on PATH.
 * @param {{exec?:Function, repo?:string|null, branch?:string, workflowName?:string, limit?:number}} [o]
 * @returns {Array<object>}
 */
export function defaultReadMainRuns({
  exec = execFileSyncThrottled, repo = null, branch = 'main', workflowName = DEFAULT_MAIN_WORKFLOW_NAME, limit = 100,
} = {}) {
  // `headSha` (added landing-freeze fix, 2026-09-27) — the one extra field `latestCompletedMainRun` needs to
  // name WHICH commit `main`'s own latest verdict belongs to, so `defaultReadMainLatestCheckRuns` below can read
  // that commit's own per-check conclusions. Purely additive: `computeMainRedWindows` ignores fields it doesn't
  // read, so every existing caller of this function sees byte-identical behaviour.
  const argv = ['run', 'list', '--branch', branch, '--limit', String(limit), '--json', 'databaseId,conclusion,status,createdAt,updatedAt,workflowName,headSha'];
  if (repo) argv.push('--repo', repo);
  const out = exec('gh', argv, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) return JSON.parse(String(out));
  const parsed = JSON.parse(String(out || '[]'));
  return (Array.isArray(parsed) ? parsed : []).filter((r) => r?.workflowName === workflowName);
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadMainLatestCheckRuns — landing-freeze fix (2026-09-27):
 * `main`'s own latest completed run's per-check conclusions (`GET /repos/.../commits/<sha>/check-runs`'s
 * `check_runs`), the one read {@link isMainLatestCheckGreen}'s IO-shell callers need — see `main-red-recovery.mjs`'s
 * own "LANDING-FREEZE FIX" section header for why `mainRedWindows` alone cannot always tell.
 *
 * `repo: null` returns `[]` WITHOUT ever calling `exec` — mirrors `ci-red-recovery-watch.mjs
 * #defaultReadRequiredContexts`'s identical guard: with no repo slug there is no `{owner}/{repo}` to resolve a
 * commit against, and guessing one would risk reading a DIFFERENT repo's commit history. Best-effort otherwise:
 * ANY failure (no run has completed yet, no `gh`, a network hiccup) degrades to `[]` — never thrown — so one
 * bad read cannot break the whole pass; `isMainLatestCheckGreen` already treats an empty/absent list as "no
 * evidence" (never a guess in either direction).
 *
 * `mainRuns` (PR #2793 review) — `main`'s run list the caller ALREADY fetched for `mainRedWindows`; passed in,
 * no second `gh run list` is made. `?per_page=100` (same review): the endpoint's default page is 30 check-runs,
 * and a busy commit can carry more — a check pushed to page 2 would silently read as "never reported".
 * @param {{exec?:Function, repo?:string|null, branch?:string, workflowName?:string, readMainRuns?:Function,
 *   mainRuns?:(Array<object>|null)}} [o]
 * @returns {Array<object>}
 */
export function defaultReadMainLatestCheckRuns({
  exec = execFileSyncThrottled, repo = null, branch = 'main', workflowName = DEFAULT_MAIN_WORKFLOW_NAME,
  readMainRuns = defaultReadMainRuns, mainRuns = null,
} = {}) {
  if (!repo) return [];
  try {
    const runs = Array.isArray(mainRuns) ? mainRuns : readMainRuns({ exec, repo, branch, workflowName });
    const latest = latestCompletedMainRun(runs);
    if (!latest?.headSha) return [];
    return readCommitCheckRuns(latest.headSha, { exec, repo });
  } catch {
    return [];
  }
}

// One commit's check-runs (`GET /repos/.../commits/<sha>/check-runs`), 100 per page, optionally narrowed to one
// check name. THROWS on failure — each caller decides what "unread" means for it.
function readCommitCheckRuns(sha, { exec, repo, checkName = null }) {
  const query = checkName ? `?check_name=${encodeURIComponent(checkName)}&per_page=100` : '?per_page=100';
  const out = exec('gh', ['api', `repos/${repo}/commits/${sha}/check-runs${query}`, '--jq', '.check_runs'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  if (isGhDeferred(out)) return JSON.parse(String(out));
  const parsed = JSON.parse(String(out || '[]'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadMainGreenFixFacts — PR #2793 review: the per-PR evidence
 * `main-red-recovery.mjs#isMainGreenFixOwed` needs before "green on main now" may excuse a failure:
 *   - `prContainsMainGreenSha` — does `headSha` already contain `greenSha` (`compare/<greenSha>...<headSha>`'s
 *     own `behind_by === 0`)?
 *   - `mergeBaseCheckRuns` — `checkName`'s check-runs at that compare's `merge_base_commit` (only read when the
 *     PR does NOT contain `greenSha`; otherwise the answer is already "not owed").
 *   - `mergeBaseRunConclusion` — the merge base's own `CI` push-run conclusion, read only when the check has no
 *     real result there (absent / `skipped`), so a cancelled run is never mistaken for "main never ran it".
 * Best-effort: no repo/sha/name, or ANY failure, yields `null` for what could not be read — which
 * `isMainGreenFixOwed` treats as no evidence, so ci-heal keeps the PR. Never thrown.
 * @param {string} headSha
 * @param {{exec?:Function, repo?:string|null, greenSha?:string|null, checkName?:string|null, workflowName?:string}} [o]
 * @returns {{prContainsMainGreenSha:(boolean|null), mergeBaseCheckRuns:(Array<object>|null), mergeBaseRunConclusion:(string|null)}}
 */
export function defaultReadMainGreenFixFacts(headSha, {
  exec = execFileSyncThrottled, repo = null, greenSha = null, checkName = null, workflowName = DEFAULT_MAIN_WORKFLOW_NAME,
} = {}) {
  const none = { prContainsMainGreenSha: null, mergeBaseCheckRuns: null, mergeBaseRunConclusion: null };
  if (!repo || !headSha || !greenSha || !checkName) return none;
  let behindBy;
  let mergeBase;
  try {
    const out = exec('gh', [
      'api', '--method', 'GET', `repos/${repo}/compare/${greenSha}...${headSha}`,
      '--jq', '{behind_by: .behind_by, merge_base: .merge_base_commit.sha}',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
    const parsed = JSON.parse(String(out || '{}'));
    behindBy = Number(parsed?.behind_by);
    mergeBase = parsed?.merge_base || null;
  } catch {
    return none;
  }
  if (!Number.isFinite(behindBy)) return none;
  if (behindBy === 0) return { ...none, prContainsMainGreenSha: true };
  if (!mergeBase) return { ...none, prContainsMainGreenSha: false };
  let mergeBaseCheckRuns;
  try {
    mergeBaseCheckRuns = readCommitCheckRuns(mergeBase, { exec, repo, checkName });
  } catch {
    return { ...none, prContainsMainGreenSha: false };
  }
  // No real result for the check at the base (absent / `skipped`) only counts if main's own CI push run there
  // FINISHED un-cancelled — read only in that case (`isMainGreenFixOwed` point 3).
  const hasRealResult = mergeBaseCheckRuns.some((c) => c?.name === checkName && String(c?.conclusion || '').toLowerCase() !== 'skipped');
  const mergeBaseRunConclusion = hasRealResult ? null : readMainCiRunConclusion(mergeBase, { exec, repo, workflowName });
  return { prContainsMainGreenSha: false, mergeBaseCheckRuns, mergeBaseRunConclusion };
}

// The newest COMPLETED `workflowName` push run's conclusion at `sha`, or `null` (none completed / read failed).
function readMainCiRunConclusion(sha, { exec, repo, workflowName }) {
  try {
    const out = exec('gh', [
      'api', '--method', 'GET', `repos/${repo}/actions/runs?head_sha=${sha}&event=push&per_page=100`, '--jq', '.workflow_runs',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
    const runs = JSON.parse(String(out || '[]'));
    const completed = (Array.isArray(runs) ? runs : [])
      .filter((r) => r?.name === workflowName && String(r?.status).toLowerCase() === 'completed')
      .sort((a, b) => Date.parse(b?.updated_at || 0) - Date.parse(a?.updated_at || 0));
    return completed[0]?.conclusion ?? null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadAheadBy — how many commits `base`'s current tip has that
 * `headSha` lacks (`GET /repos/.../compare/<headSha>...<base>`'s own `ahead_by`) — `0` once `headSha` already
 * contains `base`'s tip. CORRECTED mid-build from an earlier `gh run view --json attempt` design: live-measured
 * that rerunning a GitHub Actions run does NOT re-test against a refreshed `main` (same commit, same result),
 * so "has this PR been given a fresh look against current main" must be answered from the git graph itself, not
 * from a run's own retry counter — see `we:scripts/conveyor/main-red-recovery.mjs`'s file header for the full
 * story. `{owner}/{repo}` resolves from `repo` when given, else from this checkout's own git remote (mirrors
 * `we:scripts/conveyor/reconcile-fix-dispatch.mjs#fetchCardScopeAtRef`'s identical placeholder). Best-effort:
 * ANY failure (no `gh`, an unresolvable sha, a network hiccup) degrades to `null` — never thrown — so one bad
 * read cannot break the whole pass; `isPrCiFailureOwedRerun` already treats an unknown `aheadBy` as "not yet
 * refreshed" (the safe direction — see its own docblock).
 * @param {string} headSha
 * @param {{exec?:Function, repo?:string|null, base?:string}} [o]
 * @returns {number|null}
 */
export function defaultReadAheadBy(headSha, { exec = execFileSyncThrottled, repo = null, base = 'main' } = {}) {
  try {
    const endpoint = `repos/${repo || '{owner}/{repo}'}/compare/${headSha}...${base}`;
    const out = exec('gh', ['api', '--method', 'GET', endpoint, '--jq', '.ahead_by'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const n = Number(String(out || '').trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithMainRedFacts — we:backlog/x5uqim1-*.md (#4075/#3383):
 * attach `requiredCheckCompletedAt` / `aheadByOnMain` to every PR whose required check is currently FAILING, and
 * return `main`'s own red windows alongside — the two facts `reconcile-core.mjs#isPrCiFailureOwedRerun` needs,
 * so a `ci-heal` is never dispatched for a failure that was never this PR's own.
 *
 * PAYS THE EXTRA `gh run list --branch main` READ ONLY WHEN AT LEAST ONE PR NEEDS IT — a pass with nothing
 * currently `ci:failed` (the common case) costs nothing beyond the `latestRequiredCheck` scan it already had
 * every field for. `requiredCheckCompletedAt` comes off the ALREADY-FETCHED `statusCheckRollup` (no extra call);
 * only `aheadByOnMain` needs a fresh `gh api .../compare` read per failing PR, keyed off `headRefOid`
 * (already fetched by `defaultReadPrs`'s own `PR_LIST_JSON_FIELDS`).
 * @param {Array<object>} prs
 * soak-main-red (2026-09-26): judged across EVERY required check (`requiredChecks`, default
 * `DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS` = test/smoke/daemon-soak), not `test` alone — a PR red only on
 * `daemon-soak` while `main`'s own soak was red is owed a rebase, never a ci-heal. `requiredCheck` (singular,
 * legacy) still narrows to exactly that one check when a caller passes it.
 * @param {Array<object>} prs
 * landing-freeze fix (2026-09-27): also reads `main`'s own latest completed run's per-check conclusions
 * (`mainLatestCheckRuns`, {@link defaultReadMainLatestCheckRuns}), gated on the SAME "at least one PR needs it"
 * condition as `mainRedWindows` — the second, retrospection-independent fact `isPrCiFailureOwedRerun`'s new
 * green-check path needs. See `main-red-recovery.mjs`'s own "LANDING-FREEZE FIX" section header for the incident.
 * PR #2793 review: `main`'s run list is read ONCE and handed to `readMainLatestCheckRuns` (no second `gh run
 * list`), and a failing PR whose check IS green on main's latest run also gets `prContainsMainGreenSha` /
 * `mergeBaseCheckRuns` ({@link defaultReadMainGreenFixFacts}) — the evidence that main, not the PR, was at fault.
 * @param {{readMainRuns?:Function, readAheadBy?:Function, readMainLatestCheckRuns?:Function,
 *   readMainGreenFixFacts?:Function, requiredCheck?:string, requiredChecks?:string[], defaultBranch?:string,
 *   repo?:string|null}} [o]
 * @returns {{prs:Array<object>, mainRedWindows:Array<object>, mainLatestCheckRuns:Array<object>}}
 */
export function enrichPrsWithMainRedFacts(prs, {
  readMainRuns = defaultReadMainRuns, readAheadBy = defaultReadAheadBy,
  readMainLatestCheckRuns = defaultReadMainLatestCheckRuns, readMainGreenFixFacts = defaultReadMainGreenFixFacts,
  requiredCheck = null, requiredChecks = DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS, defaultBranch = 'main', repo = null,
} = {}) {
  const checks = requiredCheck ? [requiredCheck] : requiredChecks;
  const list = Array.isArray(prs) ? prs : [];
  const failing = list.filter((pr) => isAnyRequiredCheckFailed(pr, checks));
  if (!failing.length) return { prs: list, mainRedWindows: [], mainLatestCheckRuns: [] };

  const mainRuns = readMainRuns({ repo, branch: defaultBranch });
  const mainRedWindows = computeMainRedWindows(mainRuns);
  const mainLatestCheckRuns = readMainLatestCheckRuns({ repo, branch: defaultBranch, mainRuns });
  const failingSet = new Set(failing);
  const enriched = list.map((pr) => {
    if (!failingSet.has(pr)) return pr;
    const check = failingRequiredCheckForAttribution(pr, { requiredChecks: checks, mainRedWindows });
    const aheadBy = pr?.headRefOid ? readAheadBy(pr.headRefOid, { repo, base: defaultBranch }) : null;
    const greenSha = mainLatestGreenShaForCheck({ failingCheckName: check?.name ?? null, mainLatestCheckRuns });
    const greenFix = greenSha && aheadBy !== 0
      ? readMainGreenFixFacts(pr.headRefOid, { repo, greenSha, checkName: check.name })
      : null;
    return {
      ...pr, requiredCheckCompletedAt: check?.completedAt ?? null, requiredCheckName: check?.name ?? null, aheadByOnMain: aheadBy,
      prContainsMainGreenSha: greenFix?.prContainsMainGreenSha ?? null, mergeBaseCheckRuns: greenFix?.mergeBaseCheckRuns ?? null,
      mergeBaseRunConclusion: greenFix?.mergeBaseRunConclusion ?? null,
    };
  });
  return { prs: enriched, mainRedWindows, mainLatestCheckRuns };
}

// live incident, web-everything/web-everything PR #2752 (#4034/#2748) — see `we:scripts/lib/already-landed-content.mjs`'s
// own header for the incident and why per-file BLOB IDENTITY against `main`'s own history is the signal, not a
// plain merge-tree/current-content diff.
import { CONFLICT_LABEL } from './conflict-label.mjs';
import {
  computeAlreadyLandedVerdict, attributeCarrierPr, parseRawDiffZ, addedContentIntact,
} from '../lib/already-landed-content.mjs';

/** How many of `main`'s own commits touching one file this pass will scan for a blob match, most-recent-first,
 *  before giving up on that file (mirrors `we:scripts/backlog-stranded-sweep.mjs#AUTO_SWEEP_LOG_LIMIT`'s own
 *  "bounded, not silently widened" doctrine). NEVER GUESS past the window: a file whose match sits further back
 *  simply reads as `matchedCommit: null` for this pass — the safe direction (falls through to the ordinary
 *  dispatch paths, exactly as if this whole detector did not exist). */
export const ALREADY_LANDED_LOG_WINDOW = 300;

/** Bare label-name membership test, matching `gh --json labels`'s tolerant `{name}`-or-bare-string shape
 *  (mirrors `we:scripts/conveyor/duplicate-pr-watch.mjs#hasLabelNamed`, not imported from that file so this
 *  module never pulls in its unrelated duplicate-PR detection machinery for one boolean check). */
function hasLabel(labels, name) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean)
    .includes(name);
}

/** A full or abbreviated hex commit id — the only shape the git calls below ever put in a revision position. */
const SHA_RE = /^[0-9a-f]{7,64}$/;
/** The branch name shape `origin/<defaultBranch>` is built from — never dash-leading, never a range/revspec. */
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
const mainRefFor = (defaultBranch) =>
  (typeof defaultBranch === 'string' && BRANCH_RE.test(defaultBranch) && !defaultBranch.startsWith('-')
    ? `origin/${defaultBranch}` : null);
/** `git --literal-pathspecs`: a changed path is matched as the literal file it names, never as a glob. */
const GIT_LITERAL = ['--literal-pathspecs'];

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultFetchRef — best-effort fetch of the PR's own head, so a commit
 * this checkout may never have seen is present locally before it is read. Never throws — a fetch failure just
 * means the reads below fail closed (never landed).
 *
 * KEYED ON THE PR NUMBER, NEVER ON `headRefName` (PR #2769 security review). A PR's branch name is fully
 * author-controlled, and git accepts a dash-leading one (`--upload-pack=<cmd>`), which the earlier bare
 * `git fetch origin <headRefName>` would parse as an OPTION — measured to run an arbitrary command against a
 * local-path remote. The ref fetched here is built from a validated positive integer (`refs/pull/<n>/head`),
 * behind `--end-of-options`, into an EXPLICIT destination — the same shape
 * `we:scripts/fetch-parked.mjs#resolveNetDiff` adopted when #2373 banned the bare opportunistic form.
 * @param {number} prNumber
 * @param {{exec?:Function, remote?:string}} [o]
 */
export function defaultFetchRef(prNumber, { exec = execFileSync, remote = 'origin' } = {}) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(prNumber)) return;
  try {
    // A private namespace, not `refs/remotes/…`: never collides with a real upstream branch, and stays out of
    // every remote-tracking-ref scan the lane tooling runs.
    exec('git', ['fetch', '--quiet', '--end-of-options', remote, `+refs/pull/${n}/head:refs/already-landed/pr/${n}`], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
  } catch { /* best-effort — the reads below degrade to null, never to a guess */ }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadMergeBase — the PR head's merge-base with `mainRef`, or
 * `null`. This is the lower bound of the `<base>..main` search window (see
 * `we:scripts/lib/already-landed-content.mjs`'s own header for why a pre-base match is never delivery).
 * @param {string} headSha
 * @param {string} mainRef
 * @param {{exec?:Function}} [o]
 * @returns {string|null}
 */
export function defaultReadMergeBase(headSha, mainRef, { exec = execFileSync } = {}) {
  if (!isSha(headSha) || !mainRef) return null;
  try {
    const out = String(exec('git', ['merge-base', '--end-of-options', headSha, mainRef], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
    }) || '').trim();
    return isSha(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadChanges — what the PR changes relative to its merge-base,
 * with status, destination mode and blob per path (`git diff --raw -z --no-renames`, parsed by
 * `we:scripts/lib/already-landed-content.mjs#parseRawDiffZ`). Replaces an earlier `gh pr view --json files`
 * path list, which could not see a rename's source, a mode change, or a deletion (PR #2769 review).
 * @param {string} base
 * @param {string} headSha
 * @param {{exec?:Function}} [o]
 * @returns {Array<{status:string, path:string, dstMode:string, dstBlob:string}>}
 */
export function defaultReadChanges(base, headSha, { exec = execFileSync } = {}) {
  if (!isSha(base) || !isSha(headSha)) return [];
  try {
    const out = exec('git', ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--end-of-options', base, headSha], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    return parseRawDiffZ(out);
  } catch {
    return [];
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadEntryAt — the `{mode, blob}` a path holds at a commit
 * (`git ls-tree`), or `null` when the path does not exist there. Mode travels with the blob so a mode-only
 * change is never matched by the unchanged blob alone.
 *
 * THROWS when the read itself fails (a bad revision, a timeout, a locked repo) — it never returns `null` for
 * that, because `null` means "absent" and a deletion counts as landed on absence (PR #2769 review, round 2: a
 * failed tip read once passed for "gone from main"). {@link defaultFindMatchingMainCommit} catches and fails
 * closed.
 * @param {string} ref
 * @param {string} file
 * @param {{exec?:Function}} [o]
 * @returns {{mode:string, blob:string}|null}
 */
export function defaultReadEntryAt(ref, file, { exec = execFileSync } = {}) {
  if (!ref || !file) throw new Error('defaultReadEntryAt: ref and file are required');
  const out = String(exec('git', [...GIT_LITERAL, 'ls-tree', '-z', '--full-tree', '--end-of-options', ref, '--', file], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }) || '');
  for (const rec of out.split('\0')) {
    const m = /^(\d{6}) \w+ ([0-9a-f]{7,64})\t(.*)$/s.exec(rec);
    if (m && m[3] === file) return { mode: m[1], blob: m[2] };
  }
  return null;
}

const BLOB_READ = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 16 * 1024 * 1024 };

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultTipCarriesChange — does `main`'s tip blob still carry the PR's
 * change to one file, when the tip is NOT the PR's exact blob (`main` edited the file after carrying it)?
 *   - edited file (`baseBlob` set): a real three-way merge — `git merge-file -p --object-id <tip> <base> <pr>` —
 *     must be conflict-free AND produce the tip byte-for-byte. That is "merging the PR into `main` changes
 *     nothing": every change the PR made is already there, whatever `main` did around it. It replaced a
 *     hunk-position check that repeated lines (`}`, blank lines) could fool into calling a revert "preserved"
 *     (PR #2769 review, round 2 self-review).
 *   - added file (`baseBlob` null): `we:scripts/lib/already-landed-content.mjs#addedContentIntact` — git's empty
 *     blob is not guaranteed to exist in the object store, and an add/add merge conflicts on any difference.
 * A conflict, a binary file, or any git failure (`merge-file --object-id` needs git ≥ 2.44) THROWS or returns
 * false; the caller fails closed.
 * @param {string} tipBlob
 * @param {string|null} baseBlob
 * @param {string} prBlob
 * @param {{exec?:Function}} [o]
 * @returns {boolean}
 */
export function defaultTipCarriesChange(tipBlob, baseBlob, prBlob, { exec = execFileSync } = {}) {
  if (!isSha(tipBlob) || !isSha(prBlob) || (baseBlob !== null && !isSha(baseBlob))) return false;
  const readBlob = (b) => String(exec('git', ['cat-file', 'blob', '--end-of-options', b], BLOB_READ) ?? '');
  const tipText = readBlob(tipBlob);
  if (baseBlob === null) return addedContentIntact(tipText, readBlob(prBlob));
  // Exits non-zero on a conflict (or a binary file), which execFileSync throws on.
  const merged = String(exec('git', ['merge-file', '-p', '--object-id', '--end-of-options', tipBlob, baseBlob, prBlob], BLOB_READ) ?? '');
  return merged === tipText;
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultFindMatchingMainCommit — the commit on `<base>..mainRef` that
 * delivered this one change to `main`, or `null`. Per status:
 *   - `A`/`M`: the first commit (most-recent-first, capped at {@link ALREADY_LANDED_LOG_WINDOW}) whose entry for
 *     the path has the SAME blob AND mode the PR's head has. Robust to a rebase (blob identity ignores graph
 *     shape) and to later refinement on `main` (the match can sit anywhere in the window, not just at the tip).
 *     `main`'s tip must still CARRY the change: same mode, and either the PR's exact blob or a later edit that
 *     left the PR's change intact ({@link defaultTipCarriesChange}).
 *     A carry that `main` later reverted, or whose PR lines `main` moved on, is not delivery. The log is not
 *     `--first-parent`, so a side-branch commit merged into `main` can be the match (git's default history
 *     simplification already drops side branches whose net change to the path is zero).
 *   - `D`: the path must be absent from `mainRef`'s tip — a SUCCESSFUL read that finds nothing, never a failed
 *     one — and the deleting commit must sit in the window.
 *   - anything else (`T`ype change, unmerged, unknown): unsupported → `null`, never a guess.
 * Any failed git read makes the whole answer `null`. Bounded below by the PR's own merge-base: see
 * `we:scripts/lib/already-landed-content.mjs`'s header for why a match that predates it (a deliberate
 * restoration) is never delivery.
 * @param {{status:string, path:string, dstMode:string, dstBlob:string}} change
 * @param {{base:string, mainRef:string, exec?:Function, windowLimit?:number, readEntryAt?:Function,
 *   tipCarriesChange?:Function}} o
 * @returns {string|null}
 */
export function defaultFindMatchingMainCommit(change, {
  base, mainRef, exec = execFileSync, windowLimit = ALREADY_LANDED_LOG_WINDOW, readEntryAt = defaultReadEntryAt,
  tipCarriesChange = defaultTipCarriesChange,
} = {}) {
  const path = change?.path;
  if (!path || !isSha(base) || !mainRef) return null;
  const logWindow = (extra) => {
    const out = exec('git', [...GIT_LITERAL, 'log', '--format=%H', `-n${windowLimit}`, ...extra, `${base}..${mainRef}`, '--', path], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 16 * 1024 * 1024,
    });
    return String(out || '').split('\n').filter(Boolean);
  };
  try {
    if (change.status === 'D') {
      if (readEntryAt(mainRef, path, { exec }) !== null) return null; // still alive on main — not delivered
      return logWindow(['--diff-filter=D'])[0] || null;
    }
    if (change.status !== 'A' && change.status !== 'M') return null;
    if (!change.dstBlob || !change.dstMode) return null;
    // A match inside the window is not enough if `main` later UNDID it — wholly (a revert, deleting an added
    // file) or in part (an edit to a line the PR wrote): main's tip must still carry the PR's change.
    const tip = readEntryAt(mainRef, path, { exec });
    if (!tip || tip.mode !== change.dstMode) return null;
    if (tip.blob !== change.dstBlob) {
      const atBase = change.status === 'M' ? readEntryAt(base, path, { exec }) : null;
      if (change.status === 'M' && !atBase) return null;
      if (!tipCarriesChange(tip.blob, atBase ? atBase.blob : null, change.dstBlob, { exec })) return null;
    }
    for (const c of logWindow([])) {
      const e = readEntryAt(c, path, { exec });
      if (e && e.blob === change.dstBlob && e.mode === change.dstMode) return c;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadPullsForCommit — the PR number(s) GitHub associates with one
 * commit (`GET /repos/{o}/{r}/commits/{sha}/pulls`) — the attribution primitive
 * `we:scripts/lib/already-landed-content.mjs#attributeCarrierPr` needs, one call per DISTINCT matched commit.
 * @param {string} sha
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {number[]}
 */
export function defaultReadPullsForCommit(sha, { exec = execFileSyncThrottled, repo = null } = {}) {
  try {
    const endpoint = `repos/${repo || '{owner}/{repo}'}/commits/${sha}/pulls`;
    const out = exec('gh', ['api', endpoint, '--jq', '.[].number'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return String(out || '').split('\n').filter(Boolean).map(Number).filter(Number.isInteger);
  } catch {
    return [];
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithAlreadyLandedFacts — live incident, web-everything/web-everything
 * PR #2752 (#4034/#2748): attach `alreadyLandedInMain: {carrierPr}` to any open PR whose own content is already,
 * file-by-file, present on `main` — see `we:scripts/lib/already-landed-content.mjs`'s own header for the full
 * incident and why this needs blob identity rather than a plain diff.
 *
 * PAYS THE EXTRA READS ONLY FOR A PR CARRYING `merge-status:conflicting` — the population
 * `we:scripts/conveyor/parked-pr-conflict-watch.mjs` already narrows this to (a real merge conflict on a
 * review-parked PR), and the ONLY phase `reconcile-core.mjs`'s own `isConflictBounce` would otherwise dispatch a
 * mechanical conflict-fix for. A pass with no such PR (the common case) costs nothing beyond the label scan
 * `defaultReadPrs` already fetched every field for.
 * @param {Array<object>} prs
 * @param {{fetchRef?:Function, readMergeBase?:Function, readChanges?:Function, findMatchingCommit?:Function,
 *   readPulls?:Function, repo?:string|null, defaultBranch?:string}} [o]
 * @returns {Array<object>}
 */
export function enrichPrsWithAlreadyLandedFacts(prs, {
  fetchRef = defaultFetchRef, readMergeBase = defaultReadMergeBase, readChanges = defaultReadChanges,
  findMatchingCommit = defaultFindMatchingMainCommit, readPulls = defaultReadPullsForCommit,
  repo = null, defaultBranch = 'main',
} = {}) {
  const list = Array.isArray(prs) ? prs : [];
  const mainRef = mainRefFor(defaultBranch);
  return list.map((pr) => {
    if (!hasLabel(pr?.labels, CONFLICT_LABEL)) return pr;
    const prNumber = Number(pr?.number);
    const headSha = pr?.headRefOid;
    if (!Number.isInteger(prNumber) || prNumber <= 0 || !isSha(headSha) || !mainRef) return pr;

    fetchRef(prNumber, {});
    const base = readMergeBase(headSha, mainRef, {});
    if (!base) return pr; // no common history to bound the search by — never guess
    const changes = readChanges(base, headSha, {});
    if (!changes.length) return pr; // could not even read the diff — never guess containment from nothing

    const fileMatches = changes.map((change) => ({
      file: change.path, matchedCommit: findMatchingCommit(change, { base, mainRef }),
    }));

    const verdict = computeAlreadyLandedVerdict(fileMatches);
    if (!verdict.landed) return pr;

    const uniqueCommits = [...new Set(fileMatches.map((m) => m.matchedCommit).filter(Boolean))];
    const pullsByCommit = {};
    for (const c of uniqueCommits) pullsByCommit[c] = readPulls(c, { repo });
    const carrierPr = attributeCarrierPr(fileMatches, pullsByCommit);

    return { ...pr, alreadyLandedInMain: { carrierPr } };
  });
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithBaseRefFacts — #4265 (PR #2797 review, live incident
 * 2026-09-27): attach `baseRefSha` — this PR's OWN stacked base ref's CURRENT tip — to every PR whose
 * `baseRefName` differs from `defaultBranch` (a STACKED PR, per `reconcile-core.mjs`'s own STACKED-BASE CONFLICT
 * branch). Read PURELY LOCALLY — a plain `git rev-parse origin/<baseRefName>`, the SAME best-effort reader
 * ({@link defaultResolveMainSha}) the main-base branch's own `mainSha` already uses, just pointed at a different
 * ref — no `gh` call, no network cost of its own beyond whatever fetch already ran this tick.
 *
 * WHY THIS MATTERS: `reconcile-core.mjs`'s stacked-base branch used to hardcode `currentSha: null` for
 * `countStaleConflictFixRounds`, so its sha-vs-sha comparison never fired and EVERY round matching the base ref
 * alone counted as "the same conflict" — even across repairs against DIFFERENT, since-rebased tips of that same
 * stacked base. Three repairs against three different tips of a repeatedly-rebased base exhausted the smaller
 * per-target cap even though each repair genuinely targeted a NEW tip.
 *
 * Resolved ONCE per DISTINCT base ref, never once per PR — several stacked PRs commonly share one lane base. A
 * PR whose base IS `defaultBranch` (or names none) is untouched, and `baseRefSha` stays absent — exactly the
 * `null` `reconcile-core.mjs#planReconcile`'s `base.baseRefSha ?? null` already degrades to, the pre-#4265
 * ref-only comparison, unchanged for every caller that does not run this enrich step.
 * @param {Array<object>} prs
 * @param {{resolveRef?:Function, defaultBranch?:string}} [o]
 * @returns {Array<object>}
 */
export function enrichPrsWithBaseRefFacts(prs, { resolveRef = defaultResolveMainSha, defaultBranch = 'main' } = {}) {
  const list = Array.isArray(prs) ? prs : [];
  const shaByRef = new Map();
  return list.map((pr) => {
    const baseRefName = pr?.baseRefName ?? null;
    if (!baseRefName || baseRefName === defaultBranch) return pr;
    if (!shaByRef.has(baseRefName)) shaByRef.set(baseRefName, resolveRef(baseRefName));
    return { ...pr, baseRefSha: shaByRef.get(baseRefName) ?? null };
  });
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultReadSystemFixState — #4263: one `gh pr view` read of the fix PR
 * a `waiting-on-system-fix` ci-heal escalation named, classified through the SAME terminal-state reader
 * `pr-watch.mjs` uses (never a re-invented merged/closed check). Best-effort: any failure at all (offline, PR
 * deleted, bad number) degrades to `null` ("unknown — keep the existing refusal standing"), never a hard
 * failure of the whole pass.
 * @param {number|string} prNumber
 * @param {{exec?:Function, repo?:string|null}} [o]
 * @returns {'merged'|'closed'|'parked'|'pending'|null}
 */
export function defaultReadSystemFixState(prNumber, { exec = execFileSyncThrottled, repo = null } = {}) {
  try {
    const argv = ['pr', 'view', String(prNumber), '--json', 'state,mergedAt,labels'];
    if (repo) argv.push('--repo', repo);
    const out = exec('gh', argv, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    return classifyPrLifecycle(JSON.parse(String(out)));
  } catch {
    return null;
  }
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithSystemFixFacts — #4263 (PR #2787 review, live incident
 * 2026-09-27): a `waiting-on-system-fix` ci-heal escalation refuses further healing "until that fix lands or a
 * new push changes this head" (`reconcile-core.mjs`'s own escalation branch) — but until this fix, NOTHING ever
 * checked whether the named fix PR actually had landed; the refusal was keyed purely on the escalation's own
 * head match, so it suppressed healing FOREVER once posted, even after the referenced fix genuinely merged and
 * CI reran on the SAME (unchanged) head.
 *
 * Re-scans each PR's OWN comments with the SAME pure {@link latestCiHealEscalationForHead} reconcile-core.mjs
 * uses for its decision (never a re-derived copy that could drift), and — ONLY for a live `waiting-on-system-
 * fix` escalation — independently re-checks the referenced `systemFixRef` PR's own CURRENT state. Attaches
 * `systemFixLanded: true` when that PR has since merged or closed, so `reconcile-core.mjs`'s escalation branch
 * can re-arm instead of refusing forever. Every OTHER PR (no escalation, or a `needs-human` one with no PR to
 * re-check) is untouched — zero extra `gh` cost for the common case.
 *
 * Resolved ONCE per DISTINCT `systemFixRef`, never once per PR — several PRs commonly escalate to the same
 * system-level fix.
 * @param {Array<object>} prs
 * @param {{readSystemFixState?:Function, repo?:string|null}} [o]
 * @returns {Array<object>}
 */
export function enrichPrsWithSystemFixFacts(prs, { readSystemFixState = defaultReadSystemFixState, repo = null } = {}) {
  const list = Array.isArray(prs) ? prs : [];
  const stateByRef = new Map();
  return list.map((pr) => {
    const escalation = latestCiHealEscalationForHead(pr?.comments, pr?.headRefOid);
    if (!escalation || escalation.outcome !== 'waiting-on-system-fix' || !escalation.systemFixRef) return pr;
    const ref = escalation.systemFixRef;
    if (!stateByRef.has(ref)) stateByRef.set(ref, readSystemFixState(ref, { repo }));
    const state = stateByRef.get(ref);
    if (state !== 'merged' && state !== 'closed') return pr;
    return { ...pr, systemFixLanded: true };
  });
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithFixClaims — fix procedure (operator-approved 2026-09-27):
 * attach each PR's LIVE fix claim (`we:scripts/conveyor/fix-procedure.mjs`) as `pr.fixClaim = {who, why,
 * claimedAt}` so `planReconcile`'s `fix-claimed` refusal can see it. A local file read per PR — no `gh`, no
 * network. A read failure leaves the PR untouched (fail-open: the claim store is advisory for the planner; the
 * push guards are where it is enforced).
 * @param {Array<object>} prs
 * @param {{repo?:string, readClaim?:Function}} [o]
 */
export function enrichPrsWithFixClaims(prs, { repo = 'we', readClaim = readLiveFixClaim } = {}) {
  return (Array.isArray(prs) ? prs : []).map((pr) => {
    let entry = null;
    try { entry = readClaim({ repo, pr: Number(pr?.number) }); } catch { entry = null; }
    if (!entry?.meta?.who) return pr;
    return { ...pr, fixClaim: { who: entry.meta.who, why: entry.meta.why ?? '', claimedAt: entry.meta.claimedAt ?? null } };
  });
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#formatReport — the human half of the output, and it is not decoration.
 *
 * A PASS THAT REFUSES FOUR PRs AND PRINTS ONE LINE HAS REPRODUCED THE ORIGINAL DEFECT ONE LEVEL UP. So every
 * refusal is printed with its kind, its PR and the fact it turned on — and for the liveness refusals, the `cwd`
 * and `sha` the binding was derived from, since that derivation is itself a proxy that has already been observed
 * to bind the wrong session to the wrong PR. Grouping runs in `REFUSAL_KINDS` order (worst first) so a
 * permission-blocked session never sorts below a queued PR.
 * @param {{dispatch:Array<object>, refusals:Array<object>, notes:Array<object>}} plan
 * @returns {string}
 */
export function formatReport({ dispatch = [], refusals = [], notes = [] } = {}) {
  const lines = [];
  lines.push(`reconcile — ${dispatch.length} dispatch, ${refusals.length} refusal(s), ${notes.length} surfaced`);

  for (const kind of DISPATCH_KINDS) {
    for (const d of dispatch.filter((x) => x.kind === kind)) {
      lines.push(`  → ${kind.padEnd(6)} PR #${d.prNumber} (${d.headRefName ?? '?'}) — ${d.why}`);
    }
  }
  for (const kind of [...REFUSAL_KINDS, 'check-read-failed']) {
    for (const r of refusals.filter((x) => x.kind === kind)) {
      // The BIND EVIDENCE rides on the line itself for the liveness kinds. A refusal a reader cannot audit is
      // the thing this pass was built to remove.
      const bind = r.cwd || r.sha
        ? ` [bound via cwd=${r.cwd || '?'} sha=${(r.sha || '?').slice(0, 12)}${r.pid == null ? ' pid=absent' : ` pid=${r.pid}`}]`
        : '';
      lines.push(`  ✗ ${kind} PR #${r.prNumber} — ${r.why}${bind}`);
    }
  }
  for (const n of notes) lines.push(`  ! ${n.text}`);
  return lines.join('\n');
}

/** Read the complete exact-head REST feed, including main-red attribution evidence. */
export function defaultReadChecks({ repo, sha }, { exec = execFileSyncThrottled } = {}) {
  return parseJsonLines(exec('gh', checksArgv({ repo, sha }), {
    encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
    throttle: { op: 'pr-status-checks', repo },
  }));
}

/**
 * Hydrate truncated or incomplete check input from the exact-head REST feed. Unknown evidence is withheld from the
 * CI-consuming branches (heal, promotion) via an `unchecked` verdict, but never removes the PR from planning.
 */
/**
 * A PR GitHub reports as conflicting with its base. GitHub runs NO `pull_request` CI on a conflicting head (there is
 * no merge commit to test), so for such a PR the absence of every required check is the EXPECTED state, never a
 * failed read. Conflict facts only: the `merge-status:conflicting` label (the conflict watch's own mark), the
 * `mergeable` field, or `mergeStateStatus: DIRTY` (the same field `classifyPr` reads for the `conflicted` phase).
 */
export function isConflictingPr(pr) {
  const labels = Array.isArray(pr?.labels) ? pr.labels.map(l => (typeof l === 'string' ? l : l?.name)) : [];
  return labels.includes(CONFLICT_LABEL) || pr?.mergeable === 'CONFLICTING' || pr?.mergeStateStatus === 'DIRTY';
}

function hydrateChecks(prs, { repo, requiredChecks, readChecks }) {
  const cache = new Map();
  const ready = [], refusals = [];
  for (const pr of prs) {
    const runs = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
    const missing = (requiredChecks ?? []).filter(name => !runs.some(run => run?.name === name));
    if (runs.length < 100 && !missing.length) { ready.push(pr); continue; }
    // Live deadlock shape, PR #3771 (2026-10-03): a conflicting head can never grow its required checks, so reading
    // the REST feed every tick and refusing `check-read-failed` for "missing required checks" is a read that cannot
    // succeed and a refusal that names no real fault. The conflict repair that PR is owed (a mechanical re-sync
    // with main) does not consume CI at all. Nothing observed for ANY required name + not truncated = expected
    // absence: skip the read (it also costs a GitHub call per tick), refuse nothing, keep the empty rollup so the
    // verdict stays `unchecked` (never green, never red) for every CI-consuming branch. Observed evidence (a
    // required check that did run before the conflict) still goes through the read below.
    const conflicting = isConflictingPr(pr);
    if (conflicting && runs.length < 100 && missing.length === (requiredChecks ?? []).length) { ready.push(pr); continue; }
    const sha = pr.headRefOid;
    const key = `${repo}/${sha}`;
    if (!cache.has(key)) {
      try {
        if (!isSha(sha)) throw new Error('missing or invalid exact head SHA');
        const rows = readChecks({ repo, sha });
        if (!Array.isArray(rows) || rows.some(row => !row || !Number.isSafeInteger(row.id)
          || typeof row.name !== 'string' || !row.name || typeof row.status !== 'string'
          || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(row.status.toLowerCase())
          || (row.conclusion != null && typeof row.conclusion !== 'string')
          || (row.completed_at != null && !Number.isFinite(Date.parse(row.completed_at))))) {
          throw new Error('malformed check runs');
        }
        const unreadable = collapseRollupToLatestPerName(rows).filter(row => (!requiredChecks?.length || requiredChecks.includes(row.name))
          && row.status.toLowerCase() === 'completed'
          && !['success', ...FAILING_CONCLUSIONS, ...NON_BLOCKING_CONCLUSIONS].includes(row.conclusion?.toLowerCase()));
        if (unreadable.length) throw new Error(`unreadable conclusions: ${unreadable.map(row => row.name).join(', ')}`);
        // Absent required names are not a read failure: observed red/pending evidence must still reach the
        // reducer (red precedence, so a cancelled check heals). Only when NOTHING observed speaks for the
        // missing names is the evidence incomplete — the reducer then reports `unchecked`, which never heals
        // or promotes, and the refusal below keeps that visible.
        const absent = (requiredChecks ?? []).filter(name => !rows.some(row => row.name === name));
        const observed = collapseRollupToLatestPerName(rows).some(row => (!requiredChecks?.length || requiredChecks.includes(row.name))
          && (row.status.toLowerCase() !== 'completed' || FAILING_CONCLUSIONS.includes(row.conclusion?.toLowerCase())));
        cache.set(key, { rows: rows.map(row => ({ ...row, status: row.status.toUpperCase(),
          conclusion: row.conclusion?.toUpperCase() ?? null, completedAt: row.completed_at ?? null })),
        ...(absent.length && !observed ? { incomplete: `missing required checks: ${absent.join(', ')}` } : {}) });
      } catch (error) { cache.set(key, { error: String(error?.message ?? error) }); }
    }
    const result = cache.get(key);
    // A conflicting head's incomplete required set is expected (see above); only a real read error still refuses.
    const refused = result.error ?? (conflicting ? null : result.incomplete);
    if (refused) {
      refusals.push({ kind: 'check-read-failed', prNumber: pr.number, headRefOid: sha,
        why: `required-check hydration refused for ${repo}@${sha}: ${refused}` });
    }
    // The refusal withholds CI evidence only. The PR stays in planning for every branch that does not consume
    // it (conflict-fix, review dispatch, stand-down, label reconciliation): an unreadable read swaps the
    // truncated snapshot for an empty rollup (`unchecked`, never green or red), never drops the PR. The one thing
    // a refused hydration must NOT discard is evidence already in hand that says red or pending: that is a
    // positive observation, so a cancelled or still-running required check seen in the known snapshot keeps
    // scheduling recovery on this tick. A truncated snapshot that merely looks green is NOT kept — a later,
    // unread rerun could contradict it, so it stays `unchecked`.
    const known = runs.length && ['red', 'pending'].includes(reduceCheckState(runs, requiredChecks).state) ? runs : null;
    ready.push({ ...pr, statusCheckRollup: refused && known ? known : result.error ? [] : result.rows });
  }
  return { prs: ready, refusals };
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#runReconcilePass — read, decide, return. Every reader is injectable, so
 * the whole shell is exercisable with no network and no credential.
 * @param {{readPrs?:Function, readAgents?:Function, enrich?:Function, enrichMainRed?:Function,
 *   enrichAlreadyLanded?:Function, enrichBaseRef?:Function, enrichSystemFix?:Function, now?:number,
 *   repo?:string|null, defaultBranch?:string}} [o]
 * @returns {{dispatch:Array<object>, refusals:Array<object>, notes:Array<object>, prs:number, agents:number}}
 */
export function runReconcilePass({
  readPrs = defaultReadPrs, readAgents = defaultReadAgents, enrich = enrichAgents,
  enrichMainRed = enrichPrsWithMainRedFacts, enrichAlreadyLanded = enrichPrsWithAlreadyLandedFacts,
  // #4265 — the stacked-base conflict-fix cap's own `currentSha` (see {@link enrichPrsWithBaseRefFacts}'s own
  // docblock). Injectable exactly like every other enrich step above, so a test supplies a fixture with no git.
  enrichBaseRef = enrichPrsWithBaseRefFacts,
  // #4263 — re-arms a `waiting-on-system-fix` ci-heal escalation once its named fix PR lands (see
  // {@link enrichPrsWithSystemFixFacts}'s own docblock). Injectable exactly like every other enrich step above.
  enrichSystemFix = enrichPrsWithSystemFixFacts,
  // fix procedure — attaches each PR's live fix claim (see {@link enrichPrsWithFixClaims}). Injectable like the rest.
  enrichFixClaims = enrichPrsWithFixClaims,
  enrichTimeouts = enrichPrsWithTimeoutEvidence,
  enrichReferralHolds = enrichPrsWithReferralHolds,
  enrichRulings = enrichPrsWithIgnoredRulings,
  // The fixer-escalation ladder (default + local override, models from the routing policy). Injectable for tests.
  loadLadder = loadFixerLadder,
  now = Date.now(), repo = null, defaultBranch = 'main',
  // #2748 false-red follow-up — injectable so a test can supply a fixture with no network, matching every
  // other reader in this file. Defaults to the live, cached branch-protection read.
  readRequiredChecks = getRequiredStatusChecks, readChecks = defaultReadChecks,
  // #2787-live-incident (2026-09-27) — `origin/<defaultBranch>`'s own current tip, read PURELY LOCALLY (no `gh`
  // call at all): `reconcile-core.mjs#planReconcile`'s conflict-fix cap needs it to tell "the same conflict,
  // still stuck" apart from "a fresh conflict, main moved on" (see that function's own `mainSha` param).
  // Best-effort — see {@link defaultResolveMainSha}'s own docblock; a failed read degrades to `null`, which
  // `planReconcile` already treats as "ref-only comparison", never a hard failure of this whole pass.
  resolveMainSha = defaultResolveMainSha,
} = {}) {
  const repoKey = repo == null ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`reconcile-pass: --repo ${repo} is not a constellation repo`);
  // #x81m8xx — `repo` may be either vocabulary (the gh SLUG or the internal KEY, e.g. `--repo=we`); `gh` only
  // understands the slug, so once `repoKey` is resolved every downstream IO call gets the NORMALISED
  // `owner/name` slug, never the raw input. `repo == null` stays `null` (gh infers the repo from cwd, same as
  // before) — only a caller-supplied value is normalised.
  const resolvedRepo = repo == null ? null : CONSTELLATION_REPOS[repoKey].slug;
  const rawPrs = readPrs({ repo: resolvedRepo, ...(readPrs === defaultReadPrs ? { attributionRepo: CONSTELLATION_REPOS[repoKey].slug } : {}) });
  if (isGhDeferred(rawPrs)) return { ...rawPrs, dispatch: [], refusals: [], notes: [rawPrs.message], prs: 0, agents: 0 };
  // #4501 — read the live required-check set (branch protection, cached; degrades to
  // the repo's declared fallback if the live fetch fails) BEFORE enriching main-red facts, so BOTH
  // `enrichMainRed` below and `planReconcile` further down judge the SAME set. Moved up from just before
  // `planReconcile` — previously `enrichMainRed` ran on the OLD hardcoded `DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS`
  // default while `planReconcile` (two calls later) already got the live-fetched value: two different sets in
  // one pass over the same PRs. A repo this constellation does not know the gh slug for (`resolvedRepo` stays
  // `null`, `gh` infers from cwd) can return an unavailable empty set. The shared reducer then evaluates
  // observed CI checks, retaining red/pending/unchecked evidence; [] never means an automatic pass.
  const { checks: requiredChecks } = readRequiredChecks({ repo: resolvedRepo, branch: defaultBranch });
  // we:backlog/x5uqim1-*.md — attach `requiredCheckCompletedAt`/`aheadByOnMain` to any currently-failing
  // PR and read `main`'s own red windows, so `planReconcile` can tell a `ci-red` PR caused by a red `main` apart
  // from the PR's own defect. Costs nothing beyond what `readPrs` already fetched when nothing is `ci:failed`.
  // #4501 — `requiredChecks` now threaded through so this enrichment judges the SAME live-required set
  // `planReconcile` uses below, instead of silently falling back to `DEFAULT_MAIN_RED_ATTRIBUTED_CHECKS`.
  const hydrated = hydrateChecks(rawPrs, {
    repo: resolvedRepo ?? CONSTELLATION_REPOS[repoKey].slug, requiredChecks, readChecks,
  });
  const { prs: redPrs, mainRedWindows, mainLatestCheckRuns } = enrichMainRed(hydrated.prs, { repo: resolvedRepo, defaultBranch, requiredChecks });
  // live incident, PR #2752 (#4034/#2748) — attach `alreadyLandedInMain` to any PR carrying
  // `merge-status:conflicting` whose own content is already, file-by-file, present on `main`. Costs nothing
  // beyond the label scan `readPrs` already fetched every field for when no PR carries that label.
  const alreadyLandedPrs = enrichAlreadyLanded(redPrs, { repo: resolvedRepo, defaultBranch });
  // #4265 — attach each stacked PR's own base ref's current tip, purely locally, no `gh` cost.
  const baseRefPrs = enrichBaseRef(alreadyLandedPrs, { defaultBranch });
  // #4263 — re-check any `waiting-on-system-fix` escalation's named fix PR for having since landed.
  const fixerLadder = loadLadder();
  if (fixerLadder.error) console.error(`fixer-escalation: ignoring the local override, using the platform default: ${fixerLadder.error}`);
  const prs = enrichRulings(enrichReferralHolds(enrichTimeouts(enrichFixClaims(enrichSystemFix(baseRefPrs, { repo: resolvedRepo }), { repo: repoKey }),
    { repo: CONSTELLATION_REPOS[repoKey].slug }), { repo: CONSTELLATION_REPOS[repoKey].slug, now }), { humanAt: fixerLadder.humanAt });
  const agents = enrich(readAgents({}));
  const mainSha = resolveMainSha(defaultBranch);
  const plan = planReconcile({
    repo: repoKey, prs, agents, durableCounts: durableCountsFrom(prs), now, defaultBranch, mainRedWindows,
    mainLatestCheckRuns, requiredChecks, mainSha, fixerLadder,
  });
  return { ...plan, refusals: [...hydrated.refusals, ...plan.refusals], prs: rawPrs.length, agents: agents.length,
    openPrFiles: rawPrs.map((pr) => ({ pr: pr.number, files: Array.isArray(pr.files) && pr.files.length < 100
      ? pr.files.map((file) => typeof file === 'string' ? file : file.path) : null })),
  };
}

/**
 * we:scripts/conveyor/reconcile-pass.mjs#defaultResolveMainSha — #2787-live-incident (2026-09-27):
 * `origin/<ref>`'s own current tip, read with a PLAIN local `git rev-parse` — no `gh`, no network call of its
 * own beyond whatever fetch already happened this tick (this process's own checkout is kept fresh by the
 * SAME `assertMainNotStale` staleness guard `reconcile-fix-dispatch.mjs#runReconcileFixDispatch` already runs
 * before this pass, so `origin/<ref>` is already current by the time this reads it). Best-effort: no local git,
 * no such ref, any failure at all — degrades to `null`, exactly like every other best-effort reader in this
 * file (`defaultFetchRef`, `defaultReadMergeBase`) — a lost sha is a strictly smaller loss than failing the
 * whole reconcile pass over it.
 * @param {string} ref
 * @param {{exec?:Function}} [o]
 * @returns {string|null}
 */
export function defaultResolveMainSha(ref, { exec = execFileSync } = {}) {
  try {
    const out = String(exec('git', ['rev-parse', `origin/${ref}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }) || '').trim();
    return isSha(out) ? out : null;
  } catch {
    return null;
  }
}

// ── IO SHELL (runs only as a CLI — the exports above stay side-effect-free on import) ──────────────────────────
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const flags = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  let result;
  try {
    result = runReconcilePass({
      repo: typeof flags.repo === 'string' ? flags.repo : null,
      ...(typeof flags['prs-file'] === 'string' ? { readPrs: () => readPrsFromFile(flags['prs-file']) } : {}),
      ...(typeof flags['agents-file'] === 'string' ? { readAgents: () => readPrsFromFile(flags['agents-file']) } : {}),
    });
  } catch (e) {
    process.stderr.write(`✗ reconcile pass could not read state: ${String((e && e.message) || e).split('\n')[0]}\n`);
    process.exit(1);
  }
  if (flags.json) process.stdout.write(JSON.stringify(result) + '\n');
  else process.stdout.write(formatReport(result) + '\n');
}

/** xng7q1p: complete Vitest failure inventories only; a timeout substring is not evidence.
 * ANSI colour and GitHub timestamps are transport, not part of a test's identity.
 */
export function parseTimeoutFailures(log) {
  const incomplete = () => ({ complete: false, reason: 'incomplete-failure-inventory', failures: [] });
  // Reject, never truncate: partial inventories must not authorize a rerun.
  if (typeof log !== 'string' || log.length > 2 * 1024 * 1024) return incomplete();
  const lines = log.split('\n');
  if (lines.some((line) => line.length > 16 * 1024)) return incomplete();
  const failures = [];
  let summaryCount = 0, failedCount = 0, duration = false, current = null;
  for (const raw of lines) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[^ \t]+[ \t]/, '').trim();
    if (/Failed Suites|Unhandled Errors|Unhandled Rejection|\btruncated\b/i.test(line)) return incomplete();
    const summary = /^Tests[ \t]+(\d+) failed\b/.exec(line);
    if (summary) { summaryCount++; failedCount = Number(summary[1]); }
    if (/^Duration[ \t]+[\d.]+/.test(line)) duration = true;
    if (/^FAIL[ \t]/.test(line)) {
      const match = /^FAIL[ \t]+([^ \t]+\.(?:test|spec)\.[cm]?[jt]sx?)[ \t]+>[ \t]+(.+)$/.exec(line);
      if (!match) return incomplete();
      current = { path: match[1], name: match[2], kind: 'other' };
      failures.push(current);
    } else if (/^Test Files[ \t]/.test(line)) current = null;
    else if (current && /^Error: Test timed out in \d+ms\./.test(line)) current.kind = 'test-timeout';
  }
  if (summaryCount !== 1 || !duration || !failures.length || failures.length !== failedCount) return incomplete();
  return { complete: true, failures };
}

/** Conservative impact walk. All changed input categories use the same closure; non-source
 * changes and unresolved/ambient edges refuse. No "docs are harmless" exemption.
 * Sources are immutable, head-bound blobs supplied by the reader, never the checkout's worktree.
 */
export function timeoutImpact({ changed, sources, roots, head, sourceHead }, ts) {
  if (head !== sourceHead || !Array.isArray(roots) || !roots.length) return 'unbound-impact-evidence';
  const paths = changed.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  // A backlog card (`backlog/<id>.md`) is documentation: never imported, never a test fixture or setup file
  // (PR #3826 was card-only; the blanket "non-source ⇒ unknown" rule made every card PR ineligible forever).
  const isBacklogCard = (p) => /^backlog\/[^/]+\.md$/.test(p);
  // CARD-ONLY diffs cannot be reached by an import edge, and the failure being retried is a TIMEOUT (never an
  // assertion on content), so the walk is narrowed to the FAILING TESTS' own relative closure (it still refuses
  // an unresolvable relative import). Ambient `process`/external-package edges — which every test and the
  // shared vite config have — no longer defeat it; they cannot carry a card.
  const cardOnly = paths.length > 0 && paths.every(isBacklogCard);
  if (paths.some((p) => !isBacklogCard(p) && (!/\.[cm]?[jt]sx?$/.test(p)
      || /(^|\/)(?:[^/]*config[^/]*|[^/]*setup[^/]*|fixtures?|data|__fixtures__)(\/|\.)/i.test(p)))) {
    return 'changed-input-impact-unknown';
  }
  const seen = new Set();
  const visit = (path) => {
    if (paths.includes(path)) return `changed-dependency:${path}`;
    if (seen.has(path)) return null;
    seen.add(path);
    const source = sources[path];
    if (typeof source !== 'string') return `unresolved-dependency:${path}`;
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    if (parsed.parseDiagnostics.length) return `unparseable-dependency:${path}`;
    let unknown = false;
    const imports = [];
    const scan = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) imports.push(node.moduleSpecifier.text);
      }
      // Computed imports, require, code generation and ambient IO defeat static closure.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) unknown = true;
      // Vitest's runtime loaders bypass import declarations, including aliases/destructuring.
      // Fail closed on references as well as calls; native dynamic imports already do the same.
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node))
          && ['importActual', 'importMock'].includes(node.text)) unknown = true;
      if (ts.isElementAccessExpression(node) && !ts.isStringLiteral(node.argumentExpression)) unknown = true;
      if (ts.isIdentifier(node) && /^(require|eval|Function|process|global|globalThis|window|document|fetch|XMLHttpRequest|WebSocket|Worker|importScripts|Deno|Bun)$/.test(node.text)) unknown = true;
      if (ts.isMetaProperty(node)) unknown = true;
      if (ts.isShorthandPropertyAssignment(node) && ['setupFiles', 'globalSetup'].includes(node.name.text)) unknown = true;
      if (ts.isPropertyAssignment(node) && ['setupFiles', 'globalSetup'].includes(node.name.text)) {
        const values = ts.isArrayLiteralExpression(node.initializer) ? [...node.initializer.elements] : [node.initializer];
        if (values.some((v) => !ts.isStringLiteral(v))) unknown = true;
        else imports.push(...values.map((v) => v.text));
      }
      ts.forEachChild(node, scan);
    };
    scan(parsed);
    if (unknown && !cardOnly) return `unknown-dependency-edge:${path}`;
    // Include setup/globalSetup literal entries even though these are not import declarations.
    for (const m of source.matchAll(/\b(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/g)) {
      for (const s of m[1].matchAll(/['"]([^'"]+)['"]/g)) imports.push(s[1]);
    }
    for (const spec of imports) {
      if (spec === 'vitest' || spec === 'vitest/config') continue;
      if (!spec.startsWith('.')) { if (cardOnly) continue; return `unknown-external-dependency:${spec}`; }
      const base = posix.normalize(posix.join(posix.dirname(path), spec));
      const candidates = [base, ...['.ts', '.mjs', '.js', '.tsx', '/index.ts', '/index.js'].map((ext) => base + ext)];
      const resolved = candidates.find((p) => Object.hasOwn(sources, p));
      if (!resolved) return `unresolved-dependency:${base}`;
      const reason = visit(resolved);
      if (reason) return reason;
    }
    return null;
  };
  const walkRoots = cardOnly ? roots.filter((r) => /\.test\.[cm]?[jt]sx?$/.test(r)) : roots;
  if (cardOnly && !walkRoots.length) return 'unbound-impact-evidence';
  for (const root of walkRoots) { const reason = visit(root); if (reason) return reason; }
  return null;
}

export function classifyTimeoutEvidence(evidence, { repo, pr, head, ts }) {
  const no = (reason) => ({ eligible: false, reason });
  if (!evidence || evidence.repo !== repo || evidence.pr !== pr || evidence.head !== head) return no('wrong-repo-pr-head');
  if (!evidence.diffComplete || !Array.isArray(evidence.changed) || !evidence.checksComplete) return no('incomplete-diff-or-checks');
  if (!evidence.roots?.length) return no('unknown-test-configuration');
  if (!evidence.jobs?.length || !evidence.failedChecks?.length) return no('missing-failed-jobs');
  const covered = new Set();
  const failures = [];
  for (const job of evidence.jobs) {
    if (job.repo !== repo || job.head !== head || !Number.isSafeInteger(job.run) || !Number.isSafeInteger(job.job)
        || !Number.isSafeInteger(job.attempt) || job.attempt < 1 || job.status !== 'completed' || job.conclusion !== 'failure'
        || job.logJob !== job.job || job.logAttempt !== job.attempt || !job.workflow) return no('unbound-or-nonterminal-job');
    const inventory = parseTimeoutFailures(job.log);
    if (!inventory.complete) return no(inventory.reason);
    if (inventory.failures.some((f) => f.kind !== 'test-timeout')) return no('mixed-failure-kinds');
    covered.add(job.job);
    failures.push(...inventory.failures);
  }
  if (evidence.failedChecks.some((id) => !covered.has(id)) || covered.size !== evidence.failedChecks.length) return no('unaccounted-failing-check');
  const reason = timeoutImpact({ ...evidence, roots: [...(evidence.roots ?? []), ...failures.map((f) => f.path)] }, ts);
  if (reason) return no(reason);
  const signature = createHash('sha256').update(JSON.stringify(failures.map((f) => [f.path, f.name, f.kind]).sort())).digest('hex');
  return { eligible: true, repo, pr, head, signature, failures, jobs: evidence.jobs.map(({ log, ...job }) => job) };
}

/** A failed check that is not primary evidence: `review-gate` (red by design under a review hold) and the
 *  aggregate `test` job when at least one `test-shard (N)` job also failed (it only mirrors its shards). */
export function isDerivedTimeoutCheck(check, checks = []) {
  if (check?.name === 'review-gate') return true;
  return check?.name === 'test'
    && checks.some((c) => /^test-shard \(\d+\)$/.test(c?.name ?? '') && !['success', 'skipped', 'neutral'].includes(c.conclusion));
}

/** Repository-explicit, bounded, read-only collector. Any pagination/truncation/head race refuses.
 * This deliberately declines logs with aggregate/build failures: every failed check must carry a
 * complete test inventory. That includes the historical #3415 aggregate "test" failure.
 */
export function readTimeoutEvidence(pr, { repo, exec = execFileSyncThrottled, ts } = {}) {
  const deadline = Date.now() + 15_000;
  const api = (path, raw = false) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('evidence-read-deadline');
    const value = exec('gh', ['api', path], { encoding: 'utf8', timeout: remaining, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return raw ? String(value) : JSON.parse(value);
  };
  const head = pr.headRefOid;
  try {
    const pull = api(`repos/${repo}/pulls/${pr.number}`);
    if (pull.head.sha !== head || pull.state !== 'open') throw new Error('stale-head');
    const changed = [];
    for (let page = 1; page <= 30; page++) {
      const batch = api(`repos/${repo}/pulls/${pr.number}/files?per_page=100&page=${page}`);
      changed.push(...batch);
      if (batch.length < 100) break;
    }
    if (changed.length !== pull.changed_files || changed.length >= 3000) throw new Error('incomplete-diff');
    const checks = [];
    let total;
    for (let page = 1; page <= 30; page++) {
      const batch = api(`repos/${repo}/commits/${head}/check-runs?per_page=100&page=${page}&filter=latest`);
      total = batch.total_count;
      checks.push(...batch.check_runs);
      if (checks.length >= total) break;
    }
    if (checks.length !== total) throw new Error('incomplete-checks');
    const statuses = api(`repos/${repo}/commits/${head}/status`);
    if (statuses.total_count !== 0) throw new Error('unaccounted-commit-status');
    if (checks.some((c) => c.status !== 'completed')) throw new Error('checks-pending');
    // LIVE INCIDENT 2026-10-04, PR #3826 (card-only, test-shard (2) hit the 5000 ms default on an UNTOUCHED test):
    // the inventory counted ten `review-gate` runs (red BY DESIGN while a review label is held — never CI
    // evidence) and the derived aggregate `test` job (red only because its shard needed-failed, no vitest summary
    // of its own), so the log reads blew the 15 s evidence deadline / the aggregate read as an "incomplete
    // inventory" and the PR could never be classified eligible for the re-run that does not spend heal budget.
    const failed = checks.filter((c) => !['success', 'skipped', 'neutral'].includes(c.conclusion))
      .filter((c) => !isDerivedTimeoutCheck(c, checks));
    const jobs = failed.map((c) => {
      const match = c.details_url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)$/);
      if (!match || match[1] !== repo) throw new Error('unknown-check-origin');
      const job = api(`repos/${repo}/actions/jobs/${match[3]}`);
      const run = api(`repos/${repo}/actions/runs/${match[2]}`);
      if (job.id !== Number(match[3]) || job.run_id !== run.id || run.head_sha !== head || job.head_sha !== head
          || run.repository.full_name !== repo || job.run_attempt !== run.run_attempt) throw new Error('wrong-run-head-attempt');
      return { repo, head, run: run.id, job: job.id, attempt: job.run_attempt, workflow: run.path,
        status: job.status, conclusion: job.conclusion, logJob: job.id, logAttempt: job.run_attempt,
        url: job.html_url, log: api(`repos/${repo}/actions/jobs/${job.id}/logs`, true) };
    });
    // Refuse incomplete/mixed inventories before the more expensive immutable source reads.
    if (!jobs.length || jobs.some((j) => !parseTimeoutFailures(j.log).complete)) throw new Error('incomplete-failure-inventory');
    const tree = api(`repos/${repo}/git/trees/${head}?recursive=1`);
    if (tree.truncated) throw new Error('truncated-source-tree');
    const sourceEntries = tree.tree.filter((e) => e.type === 'blob' && /\.[cm]?[jt]sx?$/.test(e.path));
    const roots = sourceEntries.filter((e) => /(^|\/)(?:vitest|vite)\.config\./.test(e.path)).map((e) => e.path);
    if (!roots.length) throw new Error('unknown-test-configuration');
    // Lazy blob map: the classifier's dependency walk reads only the reachable closure.
    const entries = new Map(sourceEntries.map((e) => [e.path, e.sha]));
    let reads = 0;
    const cache = {};
    const sources = new Proxy(Object.fromEntries([...entries.keys()].map((p) => [p, null])), {
      get(target, path) {
        if (!entries.has(path)) return undefined;
        if (!Object.hasOwn(cache, path)) {
          if (++reads > 100) throw new Error('impact-read-budget');
          const blob = api(`repos/${repo}/git/blobs/${entries.get(path)}`);
          if (blob.encoding !== 'base64') throw new Error('unknown-blob-encoding');
          cache[path] = Buffer.from(blob.content, 'base64').toString('utf8');
        }
        return cache[path];
      },
    });
    const parser = ts ?? createRequire(import.meta.url)('typescript');
    const result = classifyTimeoutEvidence({ repo, pr: pr.number, head, sourceHead: head, changed, diffComplete: true,
      checksComplete: true, failedChecks: jobs.map((j) => j.job), jobs, sources, roots }, { repo, pr: pr.number, head, ts: parser });
    const after = api(`repos/${repo}/pulls/${pr.number}`);
    if (after.head.sha !== head || after.base.sha !== pull.base.sha || after.changed_files !== pull.changed_files) throw new Error('stale-head-or-diff');
    return result;
  } catch (error) { return { eligible: false, reason: `timeout-evidence:${error.message}` }; }
}

export function enrichPrsWithTimeoutEvidence(prs, {
  repo, read = readTimeoutEvidence, readBudget = readTimeoutBudget, enabled = process.env.WE_CI_TIMEOUT_RERUN_ENABLED !== '0',
} = {}) {
  // GRADUATED 2026-10-04 (PR #3826): the opt-in flag was never set on the edge, so the re-run that does not spend
  // heal budget was dead code and a flaky-timeout PR burned 3/3 heals. On by default now; `=0` is the kill switch.
  if (!enabled) return prs;
  return prs.map((pr) => {
    if (!(pr.statusCheckRollup ?? []).some((c) => c.name !== 'review-gate'
      && ['failure', 'timed_out'].includes(String(c.conclusion).toLowerCase()))) return pr;
    const timeoutRetryBudget = readBudget({ repo, pr: pr.number, head: pr.headRefOid });
    if (!(pr.statusCheckRollup ?? []).some((c) => c.detailsUrl?.startsWith(`https://github.com/${repo}/actions/runs/`))) {
      return { ...pr, timeoutRetryBudget, timeoutRetry: { eligible: false, reason: 'missing-check-origin' } };
    }
    return { ...pr, timeoutRetry: read(pr, { repo }),
      timeoutRetryBudget };
  });
}
