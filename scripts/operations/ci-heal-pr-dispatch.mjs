/**
 * @file ci-heal-pr-dispatch.mjs
 * Dispatch ONE ci-heal for a PR that carries `ci:failed`, from `reconcile-core.mjs`'s own durable `kind:'ci-heal'`
 * plan (multi-repo slice 7, `we:backlog/3967-*.md`) — the SAME plan `we:scripts/conveyor/reconcile-fix-dispatch.mjs`
 * reads for `fix`, never a second reconciliation. This is NOT a second ci-heal path: it fills the same
 * `fix-agent-ci-brief.md` (`BRIEF_REQUIRED_BY_KIND['ci-heal']`, the same tokens `dispatch-lane.mjs` fills) and hands
 * one effect payload to the SAME sink the tick uses (`dispatch-lane-io.mjs#createDispatchSinks`), so the provider
 * registry decides what runs: the detached `ci-heal-run.mjs` wrapper by default, or the `claude --bg` brief when
 * `WE_CI_HEAL_DISPATCH_MODE=agent`.
 *
 * CORRECTION (#x0jphk5, 2026-09-25): this paragraph previously said "the action record guard (`guardedDispatch`)
 * keys on the PR, so a second call for the same PR is `held`, never a double dispatch" — FALSE on `main`.
 * `createDispatchSinks` (`dispatch-lane-io.mjs`) never wires `guardedDispatch`/an action store at all; the
 * `actions`/`repo` this file passes it below are silently ignored there today (that wiring is a SEPARATE,
 * not-yet-landed effort — `we:backlog/3906-*.md`). What actually guards a second call for the same PR now is a
 * REAL atomic `(repo, pr, headRefOid)` claim {@link dispatchCiHeal} takes itself — `we:scripts/conveyor/
 * fix-dispatch-claim.mjs`, an `O_EXCL` file under the shared coordination sidecar with TTL-bounded dead-holder
 * reclaim, reusing `we:scripts/readiness/file-locks.mjs`'s existing lock primitives — never `guardedDispatch`.
 *
 * WHAT IT ADDED OVER THE TICK PATH, BEFORE THIS SLICE HAD A CALLER: the tick plans ci-heal solely for PRs its own
 * bookkeeping launched (`tick-core.mjs#planCiHealSpawns`, `launchedNums`, session-ephemeral), so a red PR opened by
 * hand, by a sibling process, or orphaned by a restart never reached it — and this file, though it already existed
 * (#2666), had NO CALLER AT ALL: nothing in the tree ever invoked {@link dispatchCiHeal}. {@link
 * runReconcileCiHealDispatch} is that caller — the durable, repo-agnostic sibling of `reconcile-fix-dispatch.mjs
 * #runReconcileFixDispatch`, reading the SAME `reconcile-core.mjs` plan this file's own docblock already named as
 * its source of truth. The retry cap is enforced THERE (`reconcile-core.mjs#planReconcile`'s own `ciHealCap`), on
 * the same durable floor as the tick's (`ci-heal-mark.mjs#countCiHealComments`) — never re-derived here. It never
 * touches a `review:*` label; the wrapper's only PR write is a comment.
 *
 * REPO-TAGGED SESSIONS (multi-repo slice 7 — the second half of this file's own defect: {@link dispatchCiHeal}
 * minted every session as `ci-heal-<pr>`, with no `repo` ever threaded into {@link sessionSlugFor}, so a
 * frontierui/plateau-app heal session was named IDENTICALLY to a WE one — `reconcile-core.mjs#bindAgents`'s own
 * `ci-heal-<pr>` name-bind (which DOES thread `repo` through, since it mints the repo-tagged slug it expects to
 * match) could never recognize a real non-WE heal session as live, so a genuinely in-flight sibling-repo heal
 * would have been re-planned every tick. Threading `repo` through here is what makes the two sides agree.
 */
import { pollHealAttempts } from './probation-heal-run.mjs';
import { readAgyHold } from '../lib/antigravity-run-evidence.mjs';
import { providerQuotaHold } from '../lib/provider-quota-hold.mjs';
import { resolveScorecardStorePath } from '../conveyor/run-scorecard-store.mjs';

import { readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { timeoutStateDir, timeoutKey, readTimeoutStates, readTimeoutBudget } from '../conveyor/timeout-retry-state.mjs';
import { writeJsonAtomic, withFileLock } from '../lib/atomic-json-file.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { createFileItemReader, createFileItemSinks } from './file-item-io.mjs';
import { planScaffold, SCAFFOLD_EFFECT } from './scaffold.mjs';
import {
  BRIEF_REQUIRED_BY_KIND, OPTIONAL_BRIEF_PLACEHOLDERS, REPO_AWARE_VALUE_PATTERNS, fillBrief, sessionSlugFor, DISPATCH_EFFECT,
} from './dispatch-lane.mjs';
import {
  agentArgsFromEnv, briefPath, createDispatchSinks, defaultLoadItems, findItem, REPO_ROOT,
} from './dispatch-lane-io.mjs';
import { resolveDispatchRoute as decideDispatchRoute } from '../lib/dispatch-routing-policy-io.mjs';
import { assertMainNotStale } from './review-dispatch.mjs';
import { armSelfReexecOnFastForward } from '../lib/main-staleness.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';
import { repoProfile, briefTokensForRepo } from '../lib/repo-profile.mjs';
import { resolvePrWorkUnit } from '../conveyor/pr-work-unit.mjs';
import { freeLaneNumbers, fetchPrDiffPaths, queueBudgetFrom, queueCapWhy } from '../conveyor/reconcile-fix-dispatch.mjs'; // queueBudgetFrom/queueCapWhy: card xkyw1x4
import { runReconcilePass } from '../conveyor/reconcile-pass.mjs';
import { readUnsupported, recordUnsupported } from '../conveyor/unsupported-repo.mjs';
import { readPrsFromFile } from '../conveyor/open-pr-fetch.mjs';
import {
  acquireFixDispatchClaim, releaseFixDispatchClaim, fixDispatchClaimOwner,
} from '../conveyor/fix-dispatch-claim.mjs';
import { readLiveFixClaim, withAltBranchHint } from '../conveyor/fix-procedure.mjs';
import { flushOwedWrites } from '../conveyor/ci-heal-owed.mjs';
import { describeDispatchFailure } from '../lib/describe-spawn-failure.mjs';
import { defaultPoolRoot } from '../lib/lane-pool-paths.mjs';
import { salvageEnabled, laneDirsForRepo, findSalvageCommit, pushSalvage } from '../conveyor/ci-heal-salvage.mjs';

import { readFixLoopRows, appendFixLoopRow, fixLoopConfig, fixLoopState, fixDispatchKilled,
  fixDispatchKillFile, hasFixHoldLabel } from '../conveyor/fix-loop-ledger.mjs';

const defaultFixLoop = {
  readRows: () => process.env.VITEST && !process.env.WE_FIX_LOOP_LEDGER ? [] : readFixLoopRows(),
  append: row => { if (!process.env.VITEST || process.env.WE_FIX_LOOP_LEDGER) appendFixLoopRow(row); },
  killed: () => process.env.VITEST && !process.env.WE_FIX_DISPATCH_KILL_FILE ? false : fixDispatchKilled(),
};

function defaultSalvage({ entry, root, repoKey }) {
  if (process.env.VITEST && !process.env.LANE_POOL_ROOT) return null;
  const laneDirs = laneDirsForRepo({ poolRoot: defaultPoolRoot(root),
    poolName: CONSTELLATION_REPOS[repoKey].slug.split('/')[1] });
  const candidate = findSalvageCommit({ pr: entry.prNumber, headRefOid: entry.headRefOid, laneDirs });
  if (!candidate) return null;
  const result = pushSalvage({ ...candidate, headRefName: entry.headRefName });
  return result.ok ? { pushed: true, ...candidate } : { pushed: false, ...candidate, reason: result.detail };
}

function readHealQuotaScores() {
  try {
    const store = JSON.parse(readFileSync(resolveScorecardStorePath(), 'utf8'));
    if (!Array.isArray(store.records)) throw new Error('quota scorecards have no records array');
    return store.records;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

/** Read current holds once at the CI-heal boundary. A read error is a visible refusal. */
export function routeAvailableCiHeal(p, { readHolds = readAgyHold, readScores = readHealQuotaScores, now = Date.now() } = {}) {
  try {
    const scorecards = readScores();
    if (!Array.isArray(scorecards)) throw new Error('quota scorecards unreadable');
    const availability = {
      'antigravity-claude': readHolds('claude-sonnet-4-6', { now }),
      'antigravity-gemini': readHolds('gemini-3.1-pro', { now }),
      codex: providerQuotaHold(scorecards, 'codex', now),
    };
    const route = decideDispatchRoute({ kind: 'ci-heal', scopePaths: p.scope ?? [], reason: p.reason ?? 'red-ci' }, { scorecards, ciHealAvailability: availability });
    if (!route.probationWorker && providerQuotaHold(scorecards, 'claude', now)) return { ...route, outcome: 'refused', refusal: 'native Claude quota held; no eligible CI-heal route' };
    // Empty scopes already use the native unfenced heal path; retain that behavior after checking its pool.
    if (!(p.scope ?? []).length && route.outcome === 'refused') return { ...route, outcome: 'degraded', refusal: null, probationWorker: null };
    return route;
  } catch (e) { return { outcome: 'refused', refusal: `CI-heal quota evidence unreadable: ${e.message}` }; }
}

/**
 * @param {{itemNum:(string|null), pr:number, laneRef:string, scope:string[], lane:number, reason?:string, repo?:string, headRefOid?:string|null}} planned - a `planFixesFromReconcile`
 *   entry (the same planner every repair row uses) plus a lane number and the ci-heal reason (`red-ci` unless told otherwise).
 * @param {object} [o]
 * @returns {Promise<{agentId:(string|null), sessionSlug:string, pr:number, itemNum:(string|null), lane:number, unknownTokens:string[]} | {held:true, reason:string, heldBy?:string|null}>}
 */
export async function dispatchCiHeal(planned, {
  root = REPO_ROOT, actions, repo = planned.repo ?? 'we', extraArgs = [],
  readBrief = (r) => readFileSync(briefPath(r, 'ci-heal'), 'utf8'),
  sinks = createDispatchSinks({ root, actions, repo, extraArgs }),
  // #3967 multi-repo slice 7 — mirrors `reconcile-fix-dispatch.mjs#dispatchFix`'s own seam exactly: threaded
  // straight through to `briefTokensForRepo`/`repoProfile`/`gateFor` (all three already accept them), never
  // re-derived here. A sibling repo's checkout is NOT guaranteed present on whatever host runs this — a CI
  // runner carries no `$HOME/workspace/{frontierui,plateau-app}` clone at all — so a real dispatch for one, and
  // every test of one, needs these seams open exactly as `dispatchFix`'s already are.
  home,
  checkoutExists,
  readPackageJson,
  // #x0jphk5 — injectable claim seam, mirroring `reconcile-fix-dispatch.mjs#dispatchFix`'s own (see this file's
  // own corrected header for why this replaces the `guardedDispatch` this docblock used to (wrongly) describe).
  // Stable per-process owner, NOT per-dispatch: a native session's claim is never released on spawn, so a re-dispatch
  // after reconcile frees an auth-dead/hung session must re-acquire it reentrantly (soak `claude-auth-expired`).
  // An unsettled probation attempt is already held off by `pollAttempts` above, so two owners never overlap.
  claimOwner = fixDispatchClaimOwner(),
  acquireClaim = acquireFixDispatchClaim,
  releaseClaim = releaseFixDispatchClaim,
  claimRoot,
  // fix procedure — injectable live fix-claim read (`fix-procedure.mjs#readLiveFixClaim`); a test stubs it.
  readFixClaim = ({ repo: r, pr }) => readLiveFixClaim({ repo: r, pr, ...(claimRoot ? { lockRoot: claimRoot } : {}) }),
  // agy-launcher-probation — THE ROUTE for this heal: `decideDispatchRoute` over the heal's own scope and reason,
  // read at this io edge (the same router the tick uses). Its `probationWorker` rides the effect payload; the
  // sink launches it when the gate is open, the heal is not critical, and launching is on. Quota read
  // errors and an exhausted eligible roster refuse visibly; no exception silently selects a default.
  routeHeal = routeAvailableCiHeal,
  pollAttempts = pollHealAttempts,
} = {}) {
  // fix procedure (operator-approved 2026-09-27) — a live FIX CLAIM means another fixer owns this PR's repair;
  // never spawn a ci-heal beside it (the planner already refuses `fix-claimed`; this re-checks at spawn time).
  const pending = pollAttempts({ repo, pr: planned.pr }).find(row => row.status !== 'resolved');
  if (pending) return { held: true, reason: pending.error ?? 'CI-heal attempt is still running' };
  const fixClaim = readFixClaim({ repo, pr: planned.pr });
  if (fixClaim) return { held: true, reason: 'fix-claimed', heldBy: fixClaim.meta?.who ?? fixClaim.owner ?? null };
  // #x0jphk5 — acquire BEFORE building anything below; refuse loud (never throw) when another dispatcher
  // already holds this exact `(repo, kind, pr)` — `kind: 'ci-heal'` explicit, so a `fix` claim and a
  // `ci-heal` claim for the same PR never share one slot (dup-heal-dispatch: `headSha` no longer part of the
  // claim's identity — see `fix-dispatch-claim.mjs`'s own header for the live incident this fixes).
  const claim = acquireClaim({
    repo, pr: planned.pr, kind: 'ci-heal', headSha: planned.headRefOid, scope: planned.scope, owner: claimOwner, lockRoot: claimRoot,
  });
  if (!claim.ok) {
    return { held: true, reason: claim.reason, heldBy: claim.heldBy };
  }
  const releaseOurClaim = () => releaseClaim({
    repo, pr: planned.pr, kind: 'ci-heal', owner: claimOwner, lockRoot: claimRoot,
  });
  try {
    // #3967 multi-repo slice 7 — `repo` THREADED THROUGH, matching `reconcile-core.mjs#bindAgents`'s own
    // repo-tagged `ci-heal-<pr>` slug (see this file's own docblock for the double-dispatch this fixes).
    const sessionSlug = sessionSlugFor(planned.itemNum, 'ci-heal', planned.pr, '', repo);
    const reason = planned.reason ?? 'red-ci';
    // #3960 — the repo-aware quintet, computed once from `repo`'s own profile (never re-derived here).
    const tokens = briefTokensForRepo(repo, { itemNum: planned.itemNum, prNum: planned.pr, home, checkoutExists, readPackageJson });
    if (!tokens) throw new Error(`dispatch-lane: no repo profile/gate resolved for "${repo}" — refusing to fill the ci-heal brief`);
    // #x0mn6x0 (epic #4075/#3383) — SCOPE IS OPTIONAL HERE, unlike `dispatchFix`'s identical-looking call in
    // the sibling file (`reconcile-fix-dispatch.mjs`): `dispatchFix` is only ever reached once
    // `planFixesFromReconcile` has ALREADY refused `no-scope` for an entry whose item/diff-derived scope came
    // back empty (see that function's own `if (!scope.length) refusals.push({..., kind:'no-scope'})` gate) —
    // `dispatchFix` structurally never sees `planned.scope === []`. `runReconcileCiHealDispatch` has NO
    // equivalent pre-dispatch gate (its plan and its dispatch are one loop, not two phases), so `planned.scope`
    // reaches here exactly as `resolvePrWorkUnit` left it — legitimately `[]` when a PR names no backlog item
    // AND its diff-paths fetch also came back empty (a real `gh` hiccup, not just "no item": live incident
    // 2026-09-25, PRs #2653/#2636/#2635 — each one resolves a non-empty diff-derived scope once `gh` itself
    // works, confirmed by re-running `resolvePrWorkUnit` against the real repo). Before this fix, `SCOPE` being
    // required made that combination throw HERE, uncaught by anything narrower than
    // `runReconcileCiHealDispatch`'s per-entry `catch` — which reported it as an opaque `dispatch-failed`,
    // consumed the lane popped for this entry (never returned to the pool, unlike the `held` branch below), and
    // left the PR's CI red forever, once per tick, until a human noticed. Treating `SCOPE` as optional (falling
    // back to `''` — an honestly unfenced ci-heal, never a fabricated fence) turns that hard failure into a
    // degraded-but-working dispatch; the diff-based derivation upstream (`resolvePrWorkUnit`'s
    // `attribution:'pr'` branch) still fires FIRST and supplies a real fence whenever `gh` cooperates, so this
    // is the last-resort backstop, not the common path.
    const { prompt, unknownTokens } = fillBrief(readBrief(root), {
      ITEM_NUM: planned.itemNum ?? '', PR_NUM: planned.pr, LANE_REF: planned.laneRef, LANE: planned.lane,
      SESSION_SLUG: sessionSlug, SCOPE: planned.scope.join(','), REASON: reason, ...tokens,
    }, BRIEF_REQUIRED_BY_KIND['ci-heal'], [...OPTIONAL_BRIEF_PLACEHOLDERS, 'ITEM_NUM', 'SCOPE'], REPO_AWARE_VALUE_PATTERNS);
    const route = repo === 'we' ? routeHeal({ scope: planned.scope, reason }) : null;
    if (route?.outcome === 'refused') { releaseOurClaim(); return { held: true, reason: route.refusal }; }
    const out = await sinks[DISPATCH_EFFECT]({
      launchKind: 'ci-heal', prompt: withAltBranchHint(prompt, planned.altBranch), sessionSlug, num: planned.itemNum ?? undefined, lane: planned.lane, scope: planned.scope,
      headRefOid: planned.headRefOid, claimOwner, claimRoot,
      pr: planned.pr, reason, repo, probationWorker: route?.probationWorker ?? null, routing: route,
    });
    if (out?.held) {
      // #x0jphk5 — the SINK's own (separate, unrelated) guard refused it: nothing was spawned under OUR claim
      // either, so release it rather than leaving it to expire on the TTL.
      releaseOurClaim();
      return out;
    }
    // #x0jphk5 — deliberately NOT released here: see `dispatchFix`'s own docblock (`reconcile-fix-dispatch.mjs`)
    // for why a claim on a successful spawn must outlive this call.
    return { agentId: out?.handle ?? null, sessionSlug, pr: planned.pr, itemNum: planned.itemNum ?? null, lane: planned.lane, unknownTokens };
  } catch (e) {
    releaseOurClaim();
    throw e;
  }
}

/**
 * we:scripts/operations/ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch — THE WHOLE PASS (multi-repo slice
 * 7, `we:backlog/3967-*.md`): read `reconcile-core.mjs`'s plan (via `reconcile-pass.mjs#runReconcilePass`,
 * reused, not re-run by hand), narrow it to the `kind:'ci-heal'` entries, and dispatch each — mirroring
 * `reconcile-fix-dispatch.mjs#runReconcileFixDispatch`'s own composition (plan → capability-gate → lane →
 * dispatch) for the SAME reason that file gives for `fix`: this pass is one-shot, keeps no bookkeeping of its
 * own between ticks, and reads the plan's own `bindAgents` liveness guard (a live `ci-heal-<pr>` session name)
 * to never double-dispatch.
 *
 * THE REPO GATE LIVES HERE, ON CAPABILITY, NOT IDENTITY (`docs/agent/platform-decisions.md
 * #conveyor-multi-repo-model` clause 5). `planReconcile` itself never checks `capabilities.ciHeal` — the SAME
 * design `reconcile-fix-dispatch.mjs`'s own docblock gives for `fix`: the plan decides what a PR's OWN state
 * owes, capability decides who is allowed to act on it, and those are two different questions asked by two
 * different files. A repo whose profile has `ciHeal` off has every planned `ci-heal` entry recorded
 * `unsupported-repo` (durably, via `unsupported-repo.mjs`, preserving that repo's OTHER action rows —
 * `fix`/`review` — exactly as `runReconcileFixDispatch` already does for its own `fix`/`ci-heal` split),
 * never touching the lane pool or a dispatch sink.
 *
 * ITEM/SCOPE ATTRIBUTION REUSES `pr-work-unit.mjs#resolvePrWorkUnit` — the SAME repo-aware item-or-PR
 * resolver `reconcile-fix-dispatch.mjs#planFixesFromReconcile` builds its own item/scope from (Fork 3 of the
 * ratified multi-repo decision) — never a second derivation. A CI-heal entry carries neither on `reconcile-
 * core.mjs`'s own `dispatch` row (only `prNumber`/`headRefName` — see that file's own `base` object), so this
 * pass resolves them fresh per entry, exactly as `planFixesFromReconcile` does for `fix`.
 * @param {object} [o]
 * @param {string|null} [o.repo] - a constellation repo key, gh slug, or `null` for `we`.
 * @param {Function} [o.dispatch] - injectable, defaults to the real {@link dispatchCiHeal}.
 * @param {Function} [o.reconcile] - injectable, defaults to the real {@link runReconcilePass}.
 * @param {Function} [o.pickFreeLanes] - injectable; when omitted, defaults to {@link freeLaneNumbers} scoped to
 *   THIS repo's own lane pool (`profile.lanePoolRepo`) — never the WE pool for a non-WE repo.
 * @param {Function} [o.resolveProfile] - injectable, defaults to the real {@link repoProfile}.
 * THE OWED-WRITE FLUSH RUNS FIRST (we:backlog/4352). This function is the one CI-heal call that genuinely runs
 * every tick, so it is where a CI-heal/escalation comment a GitHub budget block refused
 * (`we:scripts/conveyor/ci-heal-owed.mjs`) gets retried — never the one-shot CLIs' own next invocation, which may
 * never come. It runs BEFORE the reconcile read so a comment that lands this tick (a heal count, an escalation)
 * is already on the PR the plan is computed from, and for every repo regardless of CI colour or capability.
 * @param {Function} [o.resolveWorkUnit] - injectable, defaults to the real {@link resolvePrWorkUnit}.
 * @param {Function} [o.flushOwed] - injectable, defaults to {@link flushOwedWrites} for this repo.
 * @returns {Promise<{dispatched:Array<object>, refusals:Array<object>, reconcileRefusals:number,
 *   reconcileRefusalDetails:Array<object>, owedFlush:{posted:object[], cleared:object[], dropped:object[], kept:object[]}}>} `reconcileRefusals` stays the bare count it always was (an
 *   existing, asserted contract — see `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs`'s
 *   sibling assertion on `runReconcileFixDispatch`). `reconcileRefusalDetails` is ADDITIVE (#x0mn6x0, epic
 *   #4075/#3383): the SAME `reconciled.refusals` array the count was always derived from
 *   (`we:scripts/conveyor/reconcile-core.mjs#planReconcile` already computes a `{prNumber, kind, why, ...}`
 *   per entry — see that file's own `refuse()` closure), now handed up instead of collapsed to nothing. A PR
 *   `reconcile-core.mjs` refuses OUTRIGHT (never becoming a `kind:'ci-heal'` dispatch entry at all — e.g.
 *   `owed-ci-rerun`, `no-findings`, `live-process`, `cap-exhausted`, `stood-down`, `load-flake-hold`, `owed-elsewhere`,
 *   `nothing-owed`) left NO trace anywhere in the daemon's own tick log before this: it was neither a
 *   `dispatched` entry nor a `refusals` entry (that array only ever held THIS file's OWN per-entry refusals —
 *   `no-lane`/`held`/`dispatch-failed`/`unsupported-repo` — for PRs reconcile DID plan), so a PR silently
 *   never even reaching the plan was invisible. Live incident 2026-09-25: PRs #2635/#2636/#2653 sat
 *   `ci:failed` with the daemon logging only "dispatched 0, refused N" — #2635's real reason
 *   (`owed-ci-rerun`) lived exclusively in here and nowhere the daemon ever printed.
 */
export async function runReconcileCiHealDispatch({
  root = REPO_ROOT,
  repo = null,
  dispatch = dispatchCiHeal,
  reconcile = runReconcilePass,
  pickFreeLanes = null,
  resolveProfile = repoProfile,
  resolveWorkUnit = resolvePrWorkUnit,
  loadItems = () => defaultLoadItems(root),
  fetchDiffPaths = null,
  checkStaleness,
  prsFile, unsupportedPath,
  // Card xkyw1x4 — the heavy-test queue baseline (or a function returning it). Same contract as
  // `reconcile-fix-dispatch.mjs#runReconcileFixDispatch`'s own `queueAdmission`: a CI-heal costs like a fix, and is
  // refused `queue-cap` while the projected queue wait would pass the max. `null` = no gate.
  queueAdmission = null,
  flushOwed = (key) => flushOwedWrites({ repo: key }),
  pollAttempts = pollHealAttempts,
  retryTimeout = dispatchTimeoutRetry,
  flushTimeouts = flushTimeoutFollowups,
  timeoutHold = readTimeoutHold,
  salvage = defaultSalvage,
  fixLoop = defaultFixLoop,
  fixConfig = fixLoopConfig(),
  now = Date.now(),
} = {}) {
  const repoKey = repo == null ? 'we' : repoKeyForSlug(repo);
  if (repoKey === null) throw new Error(`ci-heal-pr-dispatch: --repo ${repo} is not a constellation repo`);
  // #x1rr9rh (multi-repo slice 2) — guards the DISPATCHING checkout (this WE checkout's own import path), not
  // the target repo; see `runReconcileFixDispatch`'s identical note for why this runs for every repo.
  assertMainNotStale(root, checkStaleness);
  // #4352 — retry any budget-refused CI-heal/escalation comment owed on this repo (see the docblock above).
  const healObservations = pollAttempts({ repo: repoKey });
  const owedFlush = flushOwed(repoKey);
  const timeoutFollowups = await flushTimeouts({ root, repo: CONSTELLATION_REPOS[repoKey].slug });
  const reconciled = reconcile({ repo, ...(prsFile ? { readPrs: () => readPrsFromFile(prsFile) } : {}) });
  const timeoutResults = [];
  for (const entry of (reconciled.dispatch ?? []).filter((row) => row.kind === 'ci-timeout-rerun')) {
    try {
      timeoutResults.push({ ...await retryTimeout(entry.timeoutRetry, { root, repo: CONSTELLATION_REPOS[repoKey].slug }),
        kind: 'ci-timeout-rerun', pr: entry.prNumber });
    } catch (error) {
      timeoutResults.push({ kind: 'ci-timeout-rerun', pr: entry.prNumber, status: 'refused', reason: error.message });
    }
  }
  const ciHealEntries = (reconciled.dispatch ?? []).filter((entry) => entry.kind === 'ci-heal');
  if (!ciHealEntries.length && timeoutResults.length) return {
    dispatched: timeoutResults.filter((r) => r.status === 'requested'),
    refusals: timeoutResults.filter((r) => r.status !== 'requested'), timeoutFollowups,
    reconcileRefusals: reconciled.refusals.length, reconcileRefusalDetails: reconciled.refusals, owedFlush,
  };
  const profile = resolveProfile(repoKey);

  // Preserve any already-recorded `fix`/`review` unsupported rows for this repo — a DIFFERENT stage this file
  // knows nothing about — and replace only its own `ci-heal` rows with what THIS pass just computed.
  const otherRows = readUnsupported({ path: unsupportedPath }).filter((row) => row.repo === repoKey && row.action !== 'ci-heal');

  if (!profile?.capabilities?.ciHeal) {
    const refusals = ciHealEntries.map((entry) => ({
      kind: 'unsupported-repo', repo: repoKey, prNumber: entry.prNumber, action: 'ci-heal',
      why: 'CI-heal dispatch requires a repo-specific brief and gate; the existing worker is WE-only.',
    }));
    recordUnsupported({ repo: repoKey, rows: [...otherRows, ...refusals], path: unsupportedPath });
    return { dispatched: [], refusals, reconcileRefusals: reconciled.refusals.length, reconcileRefusalDetails: reconciled.refusals, owedFlush };
  }
  // `ci-heal` IS supported here — clear any stale `ci-heal` unsupported rows, preserving `fix`/`review` rows.
  recordUnsupported({ repo: repoKey, rows: otherRows, path: unsupportedPath });

  const resolveDiffPaths = fetchDiffPaths ?? ((pr) => fetchPrDiffPaths(pr, { root, repo: repoKey }));
  const lanes = [...(typeof pickFreeLanes === 'function' ? pickFreeLanes() : freeLaneNumbers({ root, lanePoolRepo: profile.lanePoolRepo }))];
  const queueBudget = queueBudgetFrom(queueAdmission, { root, repo: repoKey });
  const dispatched = [];
  const refusals = [];
  for (const entry of ciHealEntries) {
    if (fixLoop.killed()) {
      refusals.push({ pr: entry.prNumber, kind: 'fix-dispatch-killed', why: `kill file ${fixDispatchKillFile()} present` });
      continue;
    }
    // TODO: expose PR labels in reconcile entries; the current plan only returns a PR count.
    if (hasFixHoldLabel(entry.labels)) {
      refusals.push({ pr: entry.prNumber, kind: 'fix-hold-label' });
      continue;
    }
    const unsettled =healObservations.find(row => row.pr === entry.prNumber && row.status !== 'resolved');
    if (unsettled) { refusals.push({ prNumber: entry.prNumber, kind: 'heal-unsettled', why: unsettled.error ?? 'owned wrapper still running' }); continue; }
    if ((owedFlush.kept ?? []).some(row => row.pr === entry.prNumber)) { refusals.push({ prNumber: entry.prNumber, kind: 'heal-accounting-owed', why: 'durable heal accounting is not confirmed' }); continue; }
    const hold = timeoutHold({ repo: CONSTELLATION_REPOS[repoKey].slug, pr: entry.prNumber, head: entry.headRefOid });
    if (hold) { refusals.push({ pr: entry.prNumber, kind: 'ci-timeout-rerun', ...hold }); continue; }
    if (salvageEnabled()) {
      let recovered = null;
      try { recovered = await salvage({ entry, root, repoKey, profile }); } catch { /* Fall through to dispatch. */ }
      if (recovered?.pushed === true) {
        dispatched.push({ kind: 'ci-heal-salvage', pr: entry.prNumber, sha: recovered.sha,
          laneDir: recovered.laneDir, headRefName: entry.headRefName });
        continue;
      }
      if (recovered?.pushed === false && recovered.sha) {
        refusals.push({ pr: entry.prNumber, kind: 'ci-heal-salvage-failed', why: recovered.reason });
      }
    }
    let loopRows = [];
    try { loopRows = fixLoop.readRows(); } catch { /* An unreadable ledger never blocks dispatch. */ }
    const loop = fixLoopState({ rows: loopRows, repo: repoKey, pr: entry.prNumber,
      head: entry.headRefOid, now, config: fixConfig });
    if (loop.held) {
      refusals.push({ pr: entry.prNumber, kind: 'fix-loop-hold',
        why: `${loop.count} ci-heal/fix sessions on head ${String(entry.headRefOid ?? '').slice(0, 7)} in ${fixConfig.windowHours}h with nothing pushed; auto-held until the head moves (WE_FIX_LOOP_HOLD=0 disables)` });
      continue;
    }
    const q = queueBudget.tryAdmit('ci-heal', { id: entry.prNumber });
    if (!q.admit) {
      refusals.push({ pr: entry.prNumber, kind: 'queue-cap', why: queueCapWhy(q) });
      continue;
    }
    let unit = null;
    try {
      unit = resolveWorkUnit({
        repo: repoKey,
        pr: { number: entry.prNumber, headRefName: entry.headRefName },
        findItem: (n) => findItem(n, loadItems),
        fetchDiffPaths: resolveDiffPaths,
      });
    } catch { unit = null; }
    const planned = {
      itemNum: unit?.itemNum ?? null, pr: entry.prNumber, laneRef: entry.headRefName,
      scope: Array.isArray(unit?.scope) ? unit.scope : [], reason: 'red-ci',
      // #x0jphk5 — carried through so `dispatchCiHeal` can key its `(repo, pr, headRefOid)` claim; dropped
      // before this slice, even though `reconcile-core.mjs`'s own `base` object already carries it on every
      // entry (see this function's own docblock — "a CI-heal entry carries neither on `reconcile-core.mjs`'s
      // own `dispatch` row" was true of item/scope, never of `headRefOid`).
      headRefOid: entry.headRefOid ?? null,
      ...(entry.altBranch ? { altBranch: entry.altBranch } : {}), // fix procedure — saved repair of a re-armed pause.
    };

    if (lanes.length === 0) {
      refusals.push({ pr: entry.prNumber, kind: 'no-lane', why: `no free lane to dispatch a CI-heal agent for PR #${entry.prNumber}` });
      continue;
    }
    planned.lane = lanes.shift();
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: this repo's own lane pool is popped
      // one at a time, so two entries in the same pass can never race for the same lane number.
      const result = await dispatch(planned, { root, repo: repoKey, extraArgs: agentArgsFromEnv() });
      if (result?.held) {
        // #x0jphk5 — nothing was spawned, so the lane this iteration popped went unused — return it to the
        // pool for the NEXT entry (mirrors `runReconcileFixDispatch`'s identical fix, `reconcile-fix-
        // dispatch.mjs`).
        lanes.unshift(planned.lane);
        refusals.push({ pr: entry.prNumber, kind: 'held', why: result.reason ?? `a CI-heal for PR #${entry.prNumber} is already in flight` });
        continue;
      }
      dispatched.push(result);
      try {
        await fixLoop.append({ repo: repoKey, pr: entry.prNumber, kind: 'ci-heal', head: entry.headRefOid,
          session: result?.session ?? result?.sessionSlug ?? `ci-heal-${entry.prNumber}` });
      } catch { /* Dispatch succeeded; ledger writes are best effort. */ }
    } catch (e) {
      refusals.push({ pr: entry.prNumber, kind: 'dispatch-failed', why: describeDispatchFailure(e) });
    }
  }

  return { dispatched: [...dispatched, ...timeoutResults.filter((r) => r.status === 'requested')],
    refusals: [...refusals, ...timeoutResults.filter((r) => r.status !== 'requested')], timeoutFollowups,
    reconcileRefusals: reconciled.refusals.length, reconcileRefusalDetails: reconciled.refusals, owedFlush };
}

const IS_CLI = process.argv[1] && new URL(import.meta.url).pathname === process.argv[1];
if (IS_CLI) {
  // xgqz204 — this CLI may fast-forward its own checkout (#3474); re-execute rather than dispatch on old code.
  armSelfReexecOnFastForward();
  const flags = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  import('../readiness/heavy-admission.mjs')
    .then(({ resolveLiveQueueBaseline }) => runReconcileCiHealDispatch({
      repo: typeof flags.repo === 'string' ? flags.repo : null, prsFile: flags['prs-file'],
      queueAdmission: ({ root }) => resolveLiveQueueBaseline({ checkoutRoot: root }),
    }))
    .then((result) => {
      if (flags.json) {
        process.stdout.write(JSON.stringify(result) + '\n');
        return;
      }
      const lines = [`ci-heal-pr-dispatch — ${result.dispatched.length} dispatched, ${result.refusals.length} refusal(s)`];
      for (const d of result.dispatched) {
        const who = d.agentId ? `agent ${d.agentId}` : 'agent (id unread)';
        const itemLabel = d.itemNum ? `item #${d.itemNum}` : 'no backlog item';
        lines.push(`  → ci-heal PR #${d.pr} (${itemLabel}) — ${who} (${d.sessionSlug}), lane-${d.lane}`);
      }
      for (const r of result.refusals) lines.push(`  ✗ ${r.kind} PR #${r.prNumber ?? r.pr} — ${r.why}`);
      const owed = result.owedFlush ?? {};
      for (const o of owed.posted ?? []) lines.push(`  ↻ owed ${o.kind} comment posted on PR #${o.pr} (head ${o.headSha})`);
      for (const o of owed.cleared ?? []) lines.push(`  ↻ owed ${o.kind} comment on PR #${o.pr} already live — cleared`);
      for (const o of owed.dropped ?? []) lines.push(`  ↻ owed ${o.kind} comment on PR #${o.pr} dropped — ${o.why}`);
      for (const o of owed.kept ?? []) lines.push(`  ↻ owed ${o.kind} comment on PR #${o.pr} still owed — ${o.why}`);
      process.stdout.write(lines.join('\n') + '\n');
    })
    .catch((e) => {
      process.stderr.write(`✗ ci-heal-pr-dispatch failed: ${String((e && e.message) || e).split('\n')[0]}\n`);
      // `process.exitCode` (remedy (a), we:scripts/lib/write-all-sync.mjs), never `process.exit(…)`: this is the
      // LAST thing this catch runs, and `process.stdout.write` above (the success path) sits close enough in
      // this promise chain that `stdout-flush-scan.mjs`'s proximity scan reads it as followed by an exit —
      // `exitCode` + a natural return lets Node drain stdout on its own, so nothing needs a synchronous drain.
      process.exitCode = 1;
    });
}

function timeoutTransaction(path, initial, fn) {
  return withFileLock(`${path}.lock`, () => {
    const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : (typeof initial === 'function' ? initial() : structuredClone(initial));
    if (state.version !== 1 || !Array.isArray(state.requests)) throw new Error('corrupt-timeout-state');
    const result = fn(state);
    writeJsonAtomic(path, state);
    return result;
  });
}

/** The read and write both name the repository; no cwd-derived GitHub target. */
export function timeoutGithubEffects({ exec = execFileSyncThrottled } = {}) {
  const api = (path) => JSON.parse(exec('gh', ['api', path], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  return {
    observe(evidence, target) {
      const prefix = `repos/${evidence.repo}`;
      const pull = api(`${prefix}/pulls/${evidence.pr}`);
      const job = api(`${prefix}/actions/jobs/${target.job}`);
      const run = api(`${prefix}/actions/runs/${target.run}`);
      return { head: pull.head.sha, open: pull.state === 'open', repo: run.repository.full_name,
        run: run.id, runHead: run.head_sha, attempt: run.run_attempt, job: job.id,
        jobRun: job.run_id, jobAttempt: job.run_attempt, status: job.status, conclusion: job.conclusion };
    },
    request(evidence, target) {
      try {
        const response = String(exec('gh', ['api', '--include', '--method', 'POST',
          `repos/${evidence.repo}/actions/jobs/${target.job}/rerun`],
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
        return /^HTTP\/\S+ 201\b/m.test(response) ? { status: 'confirmed' } : { status: 'ambiguous' };
      } catch (error) {
        // A transport timeout can follow an accepted write. Only explicit client rejections are safe
        // to retry without reconciling the observed run attempt first.
        const message = String(error.stderr ?? error.message);
        return { status: /\(HTTP 4\d\d\)/.test(message) ? 'rejected' : 'ambiguous', reason: message };
      }
    },
  };
}

function confirmedTimeouts(state) { return state.requests.filter((r) => r.status === 'confirmed').length; }

/** An ambiguous request must not become an agent heal just because this tick's evidence read failed. */
export function readTimeoutHold({ repo, pr, head, dir = timeoutStateDir() }) {
  const budget = readTimeoutBudget({ repo, pr, head, dir });
  return budget.pending ? { status: 'refused', reason: budget.reason ?? 'retry-outcome-pending' } : null;
}

/** Persist the card identity BEFORE writing it. Replay goes through the same guarded file-item sink
 * with identical bytes; a crash after the file write cannot allocate a second follow-up.
 */
async function fileTimeoutFollowup(path, { root, fileFollowup } = {}) {
  let payload;
  timeoutTransaction(path, null, (state) => {
    if (confirmedTimeouts(state) < 2 || state.card?.filed) return;
    if (state.card?.filingPid) {
      try { process.kill(state.card.filingPid, 0); return; }
      catch (error) { if (error.code !== 'ESRCH') return; }
    }
    if (!state.card) {
      const e = state.evidence;
      const details = `Two bounded timeout retry requests were confirmed for ${e.repo} PR #${e.pr}, head ${e.head}. `
        + 'This is a suspected flaky-test investigation, not proof of flakiness.\n\n'
        + e.failures.map((f) => `- we:${f.path} — ${f.name} (${f.kind})`).join('\n')
        + '\n\nObserved requests:\n'
        + state.requests.filter((r) => r.status === 'confirmed').map((r) =>
          `- run ${r.target.run}, job ${r.target.job}, attempt ${r.target.attempt}: ${r.outcome}; ${r.target.url ?? ''}`).join('\n');
      const plan = planScaffold(createFileItemReader({ root })(), {
        kind: 'story', size: 3, title: `Investigate timeout retries for PR ${e.pr} at ${e.head.slice(0, 8)}`,
        digest: details, scope: e.failures.map((f) => `we:${f.path}`).join(','),
      });
      state.card = { payload: plan, filed: false };
    }
    payload = state.card.payload;
    state.card.filingPid = process.pid;
  });
  if (!payload) return;
  try {
    if (fileFollowup) await fileFollowup(payload);
    else if (existsSync(payload.abs)) {
      if (readFileSync(payload.abs, 'utf8') !== payload.content) throw new Error('followup-content-conflict');
    } else {
      await createFileItemSinks({ root })[SCAFFOLD_EFFECT](payload);
    }
    timeoutTransaction(path, null, (s) => { s.card.filed = true; delete s.card.error; delete s.card.filingPid; });
  } catch (error) {
    timeoutTransaction(path, null, (s) => { s.card.error = error.message; delete s.card.filingPid; });
  }
}

export const TIMEOUT_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Retried independently of CI colour, head changes, heal capability and lane availability. */
export async function flushTimeoutFollowups({ root = REPO_ROOT, repo, dir = timeoutStateDir(), fileFollowup, effects = timeoutGithubEffects(),
  now = Date.now, maxAgeMs = TIMEOUT_PENDING_MAX_AGE_MS } = {}) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const path = join(dir, name);
    try {
      const state = JSON.parse(readFileSync(path, 'utf8'));
      if (state.evidence.repo !== repo || state.card?.filed) continue;
      const canonical = join(dir, `${timeoutKey(state.evidence)}.json`);
      if (path !== canonical && existsSync(canonical)) continue;
      const pending = state.requests.find((r) => r.status === 'pending');
      if (pending && !state.retired) {
        const at = new Date(now()).toISOString();
        if (!pending.reservedAt) {
          pending.reservedAt = timeoutTransaction(path, null, (current) => {
            const request = current.requests[pending.id];
            request.reservedAt ??= at;
            return request.reservedAt;
          });
        }
        if (Date.parse(at) - Date.parse(pending.reservedAt) > maxAgeMs) {
          timeoutTransaction(path, null, (current) => { current.retired ??= { reason: 'aged-out', at }; });
        } else {
          const observed = await effects.observe(state.evidence, pending.target);
          if (observed.repo === repo && observed.runHead === state.evidence.head && observed.run === pending.target.run
              && observed.job === pending.target.job && observed.jobRun === pending.target.run && observed.attempt > pending.target.attempt) {
            timeoutTransaction(path, null, (current) => {
              const request = current.requests[pending.id];
              if (request.status === 'pending') {
                request.status = 'confirmed'; request.outcome = `observed run attempt ${observed.attempt}; request attribution uncertain`;
              }
            });
          }
          if (observed.open === false) {
            timeoutTransaction(path, null, (current) => { current.retired ??= { reason: 'pr-closed', at }; });
          }
        }
      }
      await fileTimeoutFollowup(path, { root, fileFollowup });
      const after = JSON.parse(readFileSync(path, 'utf8'));
      results.push({ card: after.card?.payload.num, filed: after.card?.filed, reason: after.card?.error, retired: after.retired?.reason });
    } catch (error) { results.push({ reason: error.message }); }
  }
  return results;
}

/** Restart-safe reservation before every side effect. Pending is never treated as failure or free
 * budget. It reconciles only on an observed newer run attempt for the SAME repository and head.
 */
export async function dispatchTimeoutRetry(evidence, {
  root = REPO_ROOT, repo, dir = timeoutStateDir(), effects = timeoutGithubEffects(), fileFollowup, now = Date.now,
} = {}) {
  const refuse = (reason, extra = {}) => ({ status: 'refused', reason, ...extra });
  if (!evidence?.eligible || evidence.repo !== repo || !evidence.head || !evidence.signature
      || !evidence.jobs?.length) return refuse('invalid-timeout-evidence');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${timeoutKey(evidence)}.json`);
  // Import legacy per-signature spend under the new per-head lock on first access.
  const initial = () => {
    const legacy = readTimeoutStates(evidence, dir);
    return { version: 1, evidence, card: legacy.find((state) => state.card)?.card,
      requests: legacy.flatMap((state) => state.requests).map((request, id) => ({ ...request, id })) };
  };
  let reservation;
  const selected = timeoutTransaction(path, initial, (state) => {
    if (confirmedTimeouts(state) >= 2) return { exhausted: true, card: state.card?.payload.num };
    const pending = state.requests.find((r) => r.status === 'pending');
    if (pending) return { pending: structuredClone(pending) };
    const target = evidence.jobs.find((j) => !state.requests.some((r) => r.status === 'confirmed'
      && r.target.run === j.run && r.target.job === j.job && r.target.attempt === j.attempt));
    if (!target) return { waiting: true };
    reservation = { id: state.requests.length, signature: evidence.signature, target, status: 'pending', reservedAt: new Date(now()).toISOString(), outcome: 'reserved; API outcome unknown' };
    state.requests.push(reservation);
    return { target };
  });
  if (selected.exhausted) {
    await fileTimeoutFollowup(path, { root, fileFollowup });
    return refuse('timeout-retries-exhausted', { card: JSON.parse(readFileSync(path, 'utf8')).card?.payload.num });
  }
  if (selected.waiting) return refuse('waiting-for-new-attempt');
  const target = selected.pending?.target ?? selected.target;
  // A reservation THIS call created has had no request sent yet, so an early refusal must release it:
  // left `pending` it would read as an ambiguous in-flight request and wedge every later tick on
  // `retry-outcome-pending`. A reservation inherited from an earlier call (`selected.pending`) may have
  // been sent, so it is never released here.
  const releaseFresh = () => {
    if (reservation) timeoutTransaction(path, initial, (state) => {
      if (state.requests[reservation.id]?.status === 'pending') state.requests[reservation.id].status = 'rejected';
    });
  };
  let observed;
  try { observed = await effects.observe(evidence, target); }
  catch (error) { releaseFresh(); return refuse(`retry-observation-unknown:${error.message}`); }
  const bound = observed.repo === repo && observed.head === evidence.head && observed.runHead === evidence.head
    && observed.run === target.run && observed.jobRun === target.run && observed.job === target.job;
  if (!bound || !observed.open) { releaseFresh(); return refuse('stale-head-or-job'); }
  if (selected.pending) {
    if (observed.attempt <= target.attempt) return refuse('retry-outcome-pending');
    timeoutTransaction(path, initial, (state) => {
      const pending = state.requests[selected.pending.id];
      if (pending.status === 'pending') {
        pending.status = 'confirmed'; pending.outcome = `observed run attempt ${observed.attempt}; request attribution uncertain`;
      }
    });
    await fileTimeoutFollowup(path, { root, fileFollowup });
    return refuse('retry-reconciled-wait-for-evidence');
  }
  if (observed.attempt !== target.attempt || observed.jobAttempt !== target.attempt
      || observed.status !== 'completed' || observed.conclusion !== 'failure') {
    timeoutTransaction(path, initial, (state) => { state.requests[reservation.id].status = 'rejected'; });
    return refuse('job-no-longer-failed-at-evidenced-attempt');
  }
  let outcome;
  try { outcome = await effects.request(evidence, target); }
  catch (error) { outcome = { status: 'ambiguous', reason: error.message }; }
  timeoutTransaction(path, initial, (state) => {
    const request = state.requests[reservation.id];
    // A concurrent observer may have confirmed the pending request already; never demote it.
    if (request.status !== 'confirmed') request.status = ['confirmed', 'rejected'].includes(outcome?.status) ? outcome.status : 'pending';
    request.outcome = outcome?.status === 'confirmed' ? 'API accepted; retry result not yet observed' : (outcome?.reason ?? 'API outcome unknown');
  });
  await fileTimeoutFollowup(path, { root, fileFollowup });
  return outcome?.status === 'confirmed' ? { status: 'requested', head: evidence.head, run: target.run, job: target.job, attempt: target.attempt }
    : refuse(outcome?.status === 'rejected' ? 'retry-api-rejected' : 'retry-outcome-pending');
}
