#!/usr/bin/env node
/**
 * lane-drain.mjs — the deferred merge-queue drain (#2162, spine of #2138). CORE SLICE: drain-one-couple
 * (#2172) — land ONE already-queued lane couple onto main via the #2153 PR transport, in the manifest's
 * impl-first/WE-last order, then clear its queued marker.
 *
 * WHY (#2138 / #2162): today the integrator runs INLINE inside the producing `/workflow` run (Phase 4 of
 * `we:.claude/skills/batch-backlog-items/parallel-execute.workflow.js`). The #2138 ruling relocates it into
 * a standalone command a human launches as ready lanes accumulate: every producing session (parallel or
 * solo #2123) stops at "lane pushed + marked ready-to-merge", and this drain lands the queue serially under
 * the SAME integrator contract. This file is the CORE that lands ONE couple; the outer monitor/watch loop
 * (#2173), the producer stop-at-push wiring (#2174), and the reopen-on-fail reconcile (#2175) are its
 * sibling slices under the #2162 epic. It consumes the three shipped primitives: the ready-to-merge token
 * (`we:scripts/readiness/queued-state.mjs`, #2161), the lane manifest (`we:scripts/readiness/lane-manifest.mjs`,
 * #2163), and the PR substrate (`we:scripts/pr-land.mjs`, #2153) — it re-uses pr-land, never re-implements
 * the merge.
 *
 * CONTRACT (the integrator invariants this preserves):
 *  - IMPL-FIRST / WE-LAST: land each repo's `lane/*` ref in `orderedRepos` order; WE carries the
 *    `active→resolved` flip and lands LAST, so a failed impl merge never leaves a false `resolved` (#96
 *    atomicity by ordering, not a distributed transaction). STOP the couple at the first repo that fails.
 *  - CROSS-ITEM blockedBy: a manifest may name other queued items that must land first — if any is still
 *    queued, this couple is NOT ready; report `waitOn` and drain nothing (the monitor #2173 retries later).
 *  - SINGLE CLEAR POINT: only after the WE (resolve-carrying) ref lands does the drain `unqueue` the item —
 *    the queued marker is cleared exactly once, at landing (#2161).
 *
 * POST-DRAIN RECONCILE (#2175): after each couple, `planPostDrain` decides the cleanup. On a LANDED couple the
 * drain deletes the `.lane-manifest.json` it carried onto main (post-land cleanup). On a FAILED couple
 * (merge red / resolve unreachable) it reconciles the stranded WE item `active→open` (`release --force`) so it
 * honestly re-enters as not-being-worked — WHILE the queued marker + `lane/*` refs are PRESERVED for the next
 * drain pass to retry (the drain-side of the #2072 closeout). Housekeeping publishes via the SANCTIONED
 * `push-if-green.mjs` helper — never a raw main push (the #2172 transport contract).
 *
 * ON-LAND CLEANUP (#2748): the drain's terminal land event is the AUTHORITATIVE, universal owner of post-land
 * cleanup — it fires for EVERY land path (conveyor delivery agent, solo `/pr`, `/finish`), not just a
 * conveyor-armed watcher. On a landed couple the drain (a) OWNS the `active`/`open`→`resolved` card flip
 * (`resolveLandedItem`) when the producer didn't pre-author it — kept WE-last + frontmatter-strict so a failed
 * impl half never false-resolves (#96) — and (b) RELEASES the item's lane lease in every pool it held
 * (`releaseItemLeases` → `lane-pool release --all-pools --item`), so a finished lane never lingers as a ghost.
 * The no-land-event orphan (an agent that died before opening a PR) is covered by the pool's own acquire-native
 * reaper (`lane-pool reapDeadLeasesInPool`, also #2748) — together they retire the "cleanup hangs off the
 * delivery agent's exit" coupling behind the ghost-lane / stale-card / wasted-re-dispatch bug family.
 *
 * The pure planners (`planDrain`, `planWatch`, `planPostDrain`, `buildPrLandArgs`) are unit-tested in
 * scripts/__tests__/lane-drain.test.mjs; the CLI owns git/pr-land/backlog at its boundary (mirrors
 * pr-land.mjs / lane-review.mjs).
 *
 * Usage:
 *   node scripts/lane-drain.mjs drain-one 2153 --manifest=/path/to/.lane-manifest.json   # land the couple for #2153
 *   node scripts/lane-drain.mjs drain-one 2153 --manifest=… --dry-run                     # print the ordered pr-land plan, land nothing
 *   node scripts/lane-drain.mjs drain-one 2153 --manifest=… --body-file=pr-body.md        # attach a PR body (the #2170 dismissals) to each PR
 *   node scripts/lane-drain.mjs drain-one 2153 --manifest=… --json                        # machine-readable result
 *   node scripts/lane-drain.mjs drain                                                      # ONE cascade pass: drain every ready couple in the queue, then regen derived once (#2173)
 *   node scripts/lane-drain.mjs drain --dry-run --json                                     # plan the queue (ready/deferred/invalid), drain nothing
 *   node scripts/lane-drain.mjs watch --interval=30                                        # poll + drain, then keep waiting for new producer enqueues (human-launched; --max-idle=N to bound)
 *
 * SUBCOMMANDS: `drain-one` lands a KNOWN couple (the CORE, #2172). `drain`/`watch` are the OUTER monitor loop
 * (#2173): they poll queued.json, read each queued item's `.lane-manifest.json` off its WE lane ref, order by
 * cross-item blockedBy (a couple whose blockedBy is still queued DEFERS until a later pass), drain each ready
 * couple serially via `drain-one`, and regenerate WE derived artifacts ONCE at the end (the Phase 4c
 * relocation). `drain` = one cascade pass then exit; `watch` = also wait (poll `--interval`s) for producers to
 * enqueue more. The pure `planWatch(queuedState, manifestByNum)` decides ready/deferred order (unit-tested).
 *
 * The manifest path is supplied by the caller (the monitor #2173 reads each queued item's
 * `we:.lane-manifest.json` off its WE lane ref and passes it here) — drain-one lands a KNOWN couple; DISCOVERY
 * is the monitor's job. Exit codes: 0 = landed (or dry-run / not-ready-reported); 2 = a repo merge was RED /
 * failed (couple stopped, main left as far as it got); 3 = bad input (no manifest, invalid, not queued).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync, existsSync, renameSync } from 'node:fs';
import { resolve, join, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { parseQueued, isQueued, queuedNums } from './readiness/queued-state.mjs';
import { parseManifest, validateManifest, orderedRepos, extractManifestFromBody, MANIFEST_FILENAME } from './readiness/lane-manifest.mjs';
import { isHash, isNum, idFromName, applyLedger, swapHashes, mapHashReferences } from './backlog/id.mjs';
import { HASH_PATH_CITE_SOURCE, findHashPathCitesInGrepLines, findHashPathCiteOutsideBacklog } from './lib/citation-check.mjs'; // #4075 follow-up (xmd4pfa) — the pre-push hash-path-citation backstop, one pattern shared with check:standards' own gate
// #2603 — the drain's resolve-reachable check reads `status:` FRONTMATTER-strict (see `resolveReachableFromBody`),
// never loose over the whole body. `readField` parses only the first `---`…`---` block.
import { readField } from './backlog/frontmatter.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
// #2779-incident (2026-09-26 03:14Z) — every drain-authored commit message is wrapped in this runtime guard
// (belt, alongside the unit-test suspenders in commit-message-safety.test.mjs): a template edit that
// reintroduces a GitHub closing-keyword + #N shape (`resolve #N`, `fixes #N`, …) throws HERE, at the point of
// the write, rather than silently landing on `main` and auto-closing whatever #N happens to name. See that
// module's own docstring for the full incident account.
import { assertNoClosingKeywordRef } from './lib/commit-message-safety.mjs';
import { withNumberingLock, lockResultOr, acquireDrainLease, heartbeatDrainLease, releaseDrainLease, drainLeaseStatus, drainOwner, DRAIN_LOCK_ROOT, localRepoSlug } from './readiness/drain-lock.mjs'; // #2391 dual-lock: numbering mutex + whole-process drain lease (#3440 localRepoSlug keys it per-repo); lockResultOr (#xuqk1vp) safely reads a lock outcome that may have refused to run

// ── flag parsing (mirrors pr-land.mjs / lane-review.mjs) ──────────────────────────────────────────────
const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const posNum = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const flags = {};
for (const a of argv) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
}
const expandHome = (p) => (p && p.startsWith('~') ? p.replace(/^~/, homedir()) : p);

// #2410 slice D — map the parsed `--converge` flag (+ `WE_CONVERGENCE_LOOP` env) into the off-by-default
// convergence-loop switch via the pure, single-sourced `convergenceLoopEnabled` predicate (defined below in the
// PURE helpers; called lazily from `runWatch` so it never hits the temporal dead zone at module load). `--converge`
// turns the unified loop on, `--converge=false` forces it off, else it falls back to the env and finally OFF.
const convergeSwitch = () => convergenceLoopEnabled({
  flag: flags.converge === true ? true : (flags.converge === 'false' ? false : undefined),
  env: process.env.WE_CONVERGENCE_LOOP,
});

// Per-repo landing config (mirrors REPOS in the orchestrator): where each repo's checkout lives (WE = the
// drain's cwd = primary) and its own gate. pr-land runs gh/git in `path`; the PR's required CI check is the
// per-repo landing authority (#1937), so the drain does not re-run the gate itself.
export const DRAIN_REPOS = {
  we: { name: 'webeverything', path: null /* primary checkout = cwd */ },
  frontierui: { name: 'frontierui', path: '~/workspace/frontierui' },
  'plateau-app': { name: 'plateau-app', path: '~/workspace/plateau-app' },
};

// ── PURE helpers (unit-tested in scripts/__tests__/lane-drain.test.mjs) ────────────────────────────────

// ── #2410 slice D — required-`test`-green: the ONE classifier + the off-by-default convergence switch ──────
//
// The drain family reads a GitHub required-check conclusion into land-relevant state in exactly ONE place here,
// so the "test-red strand" is single-sourced: BOTH the convergence loop's land clause (via the boolean
// `deriveNegotiationOutcome` consumes) and `lane-resume`'s `landDecision` route through this, retiring
// lane-resume's own hand-rolled FAIL list (its separate red-CI strand). `green` = the required check succeeded
// (landable); `red` = a definitive failing conclusion (a real bug — never land); `pending` = not-yet-reported /
// neutral (wait, don't land yet).

/** The definitive FAILING conclusions of a required check (a `red` state — never land). Single-sourced so
 *  lane-resume no longer keeps its own copy (the retired strand). */
export const REQUIRED_CHECK_FAIL_CONCLUSIONS = Object.freeze([
  'FAILURE', 'CANCELLED', 'TIMED_OUT', 'ERROR', 'ACTION_REQUIRED', 'STARTUP_FAILURE',
]);

/** Classify a required-check conclusion string into land-relevant state. Pure. `green` = SUCCESS; `red` = a
 *  definitive failure; `pending` = anything else (not reported / neutral / in-progress). */
export function requiredCheckState(conclusion) {
  const c = String(conclusion || '').toUpperCase();
  if (c === 'SUCCESS') return 'green';
  if (REQUIRED_CHECK_FAIL_CONCLUSIONS.includes(c)) return 'red';
  return 'pending';
}

/** Is a required-check conclusion GREEN? The boolean the convergence loop's CI-green land clause consumes
 *  (`deriveNegotiationOutcome({ requiredTestGreen })`). Pure — only an explicit SUCCESS is green (red AND pending
 *  are both not-green, so the clause fails closed on an undetermined check). */
export const isRequiredTestGreen = (conclusion) => requiredCheckState(conclusion) === 'green';

/** The unified convergence loop (epic #2410) is OFF BY DEFAULT — it ships behind an opt-in switch, scoped to
 *  small/non-security diffs first (graduating per-repo on a clean track record). */
export const CONVERGENCE_LOOP_DEFAULT_ENABLED = false;

/** The `scoreEscalation` signals that make a diff INELIGIBLE for the off-by-default convergence auto-land: any
 *  security/high-trust signal (`blast-radius` / `gate-self` / `statute`) → NOT "non-security"; a `size` signal →
 *  NOT "small". A scoped-out diff still gets reviewed — it is only kept out of the loop's auto-land path (a human
 *  gates it), the deliberate "small/non-security first" rollout. */
export const CONVERGENCE_INELIGIBLE_SIGNALS = Object.freeze(['blastRadius', 'gateSelf', 'statute', 'size']);

/** Is the convergence loop enabled? Pure. An explicit `flag` wins (`true` = on, `false` = off — the CLI maps
 *  `--converge` → `true` and `--converge=false` → `false`); else the `WE_CONVERGENCE_LOOP` env (`1`/`true`/`on`/
 *  `yes` = on); else OFF (the #2410 off-by-default rollout). Kept a pure predicate so the gate is single-sourced +
 *  testable, not re-derived per caller.
 *  @param {{flag?: boolean, env?: string}} [o]
 *  @returns {boolean} */
export function convergenceLoopEnabled({ flag, env } = {}) {
  if (flag === true) return true;
  if (flag === false) return false;
  if (env != null && ['1', 'true', 'on', 'yes'].includes(String(env).trim().toLowerCase())) return true;
  return CONVERGENCE_LOOP_DEFAULT_ENABLED;
}

/** Is this diff ELIGIBLE for the convergence loop's auto-land? Pure. It must be `enabled` AND fire none of the
 *  `CONVERGENCE_INELIGIBLE_SIGNALS` (small + non-security). `signals` is a `scoreEscalation` signals object.
 *  Returns `{ eligible, reasons }` (reasons name WHY it was held back), so a caller surfaces the scope-out.
 *  @param {{enabled?: boolean, signals?: object}} [o]
 *  @returns {{eligible: boolean, reasons: string[]}} */
export function convergenceEligible({ enabled = false, signals = {} } = {}) {
  if (!enabled) return { eligible: false, reasons: ['convergence loop disabled (off by default — opt in with --converge / WE_CONVERGENCE_LOOP=1)'] };
  const s = signals || {};
  const blocking = CONVERGENCE_INELIGIBLE_SIGNALS.filter((sig) => s[sig]);
  if (blocking.length) return { eligible: false, reasons: blocking.map((sig) => `${sig} — scoped out (small/non-security diffs first, #2410)`) };
  return { eligible: true, reasons: [] };
}

/**
 * Plan a single couple's drain from its manifest + the current queued state. Pure — decides ORDER,
 * readiness, and the resolve carrier without touching git. Returns:
 *   { ok, errors, ready, waitOn, steps:[{repo, ref, carriesResolve}], resolveRepo }
 *  - `ok:false` (+ errors) — the manifest is invalid or the item is not queued → the caller must not drain.
 *  - `ready:false` (+ waitOn) — a cross-item `blockedBy` dependency is still queued (unlanded) → defer.
 *  - `steps` — repos in impl-first/WE-last merge order (the exact pr-land sequence); `resolveRepo` = WE.
 */
export function planDrain(manifest, queuedState) {
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, errors: v.errors, ready: false, waitOn: [], steps: [], resolveRepo: null };
  const num = String(manifest.item).padStart(3, '0');
  if (!isQueued(queuedState, num)) {
    return { ok: false, errors: [`#${num} is not queued (nothing to drain — the token says it is not ready-to-merge)`], ready: false, waitOn: [], steps: [], resolveRepo: null };
  }
  // A cross-item blockedBy that is STILL queued has not landed yet → this couple must wait (the monitor
  // retries once the predecessor drains). A blockedBy already off the queue is considered landed.
  const waitOn = (manifest.blockedBy ?? [])
    .map((n) => String(n).padStart(3, '0'))
    .filter((n) => isQueued(queuedState, n));
  const steps = orderedRepos(manifest).map((r) => ({ repo: r.repo, ref: r.ref, carriesResolve: !!r.carriesResolve }));
  const resolveRepo = (steps.find((s) => s.carriesResolve) || {}).repo || 'we';
  return { ok: true, errors: [], ready: waitOn.length === 0, waitOn, steps, resolveRepo };
}

/**
 * Build the `node scripts/pr-land.mjs …` argv for one repo's ref. Pure. `--no-ff` merge history is pr-land's
 * default; `--repo` is passed only for a non-primary (non-WE) repo (WE lands in the drain's cwd). A body
 * file (the #2170 dismissals PR body) is forwarded when supplied. `--json` so the drain reads the result.
 *
 * #3321 — `--no-require-verified` IS MANDATORY ON THIS ARGV, and it is not a weakening of that item's gate; it is
 * ONE OF THE TWO call sites that item's opt-out exists for. THIS CLAUSE USED TO READ "the one call site", which was
 * wrong: review round 2 of PR #1609 found the parallel `/workflow` producer
 * (`we:skills-src/batch-backlog-items/parallel-execute.workflow.js`) still emitting four flag-free `pr-land` argvs.
 * RETRACTION — this clause used to read: "The complete, swept list lives in the OPT-OUT entry of
 * `we:scripts/lib/lane-verify.mjs`'s header — add to it there, and the caller-sweep test in
 * `we:scripts/__tests__/lane-verify.test.mjs` will hold you to it." THAT INSTRUCTION WOULD HAVE COST THE NEXT
 * AUTHOR: at the time it was written the caller-sweep test iterated TWO HARD-CODED FILENAMES, so it would NOT
 * have held anyone to anything for a caller added in a new file — review round 3 of PR #1609 measured a flag-free
 * invocation added to a third file passing the suite green.
 * As of round 4 the sweep reads the TRACKED FILE SET (`git grep -lF pr-land.mjs`, minus `pr-land.mjs`'s own
 * `--help` banner) and requires every invocation it finds to declare its posture — carry a verify flag, or be
 * preceded within 3 lines by a `verify-lane.mjs` / `run.mjs verify` run. So the enforcement the sentence promised
 * now exists, and a new call site anywhere in the repo reddens the suite rather than reaching the gate. The list
 * in the OPT-OUT header is the roster of callers that TAKE this escape, not a completeness claim about `pr-land`
 * call sites; keep it current, but the test — not that list — is what holds.
 * #3321 flipped `resolveVerifyOptions`'s default to "verification
 * required", which is right for a lane session landing its OWN clone — the clone is where `verify-lane.mjs` writes
 * `.git/.lane-verify`, so the marker is reachable and demanding it is meaningful. The drain is the opposite shape on
 * BOTH counts, so a flag-free argv here is a gate that can only ever fail:
 *   - it lands WE from the PRIMARY checkout (`DRAIN_REPOS.we.path = null` ⇒ cwd, above), and the lane it is landing
 *     is a SEPARATE CLONE. A lane's `.git/.lane-verify` can therefore NEVER appear in the git dir pr-land reads, so
 *     the marker is not merely missing-this-time but structurally unreachable — the gate would return `unverified`
 *     for every queued couple, forever, and `reopenStrandedItem` would send each item back to `open`.
 *   - the drain does not need it: the PR's required GitHub check is the per-repo landing authority (#1937, stated
 *     on `DRAIN_REPOS` above), and a couple only reaches here already labelled `ready-to-merge` — i.e. green.
 * This is exactly the "verifies elsewhere" caller #3321's opt-out was written for. #2833's resolution said the same
 * of this path ("the CI-gated drain / parallel-workflow paths verify via the required GitHub check") — but read that
 * as WHY the opt-out is right here, NOT as evidence those paths are already wired for it. Under #3321's default they
 * are unblocked only where the flag is actually passed; reading that sentence the other way is what produced the
 * wedge #1609's review caught, twice. It is the NARROW
 * opt-out, never the `WE_LAND_UNVERIFIED=1` break-glass: a fresh `running` marker (the #2833 stall) and a corrupt
 * marker still refuse under it, so a genuinely half-run verification is still caught here.
 */
export function buildPrLandArgs({ ref, repoPath = null, bodyFile = null, dryRun = false } = {}) {
  const args = ['scripts/pr-land.mjs', `--ref=${ref}`, '--json', '--no-require-verified'];
  if (repoPath) args.push(`--repo=${repoPath}`);
  if (bodyFile) args.push(`--body-file=${bodyFile}`);
  if (dryRun) args.push('--dry-run');
  return args;
}

/**
 * Plan a full watch/drain pass over the queued set (#2173 — the drain's OUTER loop). Pure — decides, from
 * the queued token + each queued item's manifest, WHICH couples are ready to land now and in what ORDER,
 * WITHOUT touching git. The CLI reads each manifest off its WE lane ref and injects them as `manifestByNum`
 * ({ paddedNum: manifest|null }); discovery is the CLI's job, the ordering decision is here (so it is
 * unit-tested, mirroring planDrain). Returns:
 *   { ready:[num…], deferred:[{num, waitOn:[num…]}], invalid:[{num, errors}], unresolvable:[num…] }
 *  - ready        — queued, manifest valid, and every cross-item blockedBy has already LEFT the queue (landed).
 *                   A couple whose blockedBy is another *queued* (unlanded) item is NOT ready — it waits. Since a
 *                   still-queued blocker defers its dependent, the ready set within a pass is mutually
 *                   independent; ordered by num for determinism. Cross-item CHAINS drain across passes: draining
 *                   the head clears it from the queue, so the next pass finds the dependent ready (the cascade).
 *  - deferred     — queued + valid but a cross-item blockedBy is still queued (unlanded) → a later pass retries.
 *  - invalid      — queued but its manifest fails validation → skip + report (never drained; a bad couple must
 *                   not wedge the queue).
 *  - unresolvable — queued but no manifest could be read off its lane ref (missing/unreadable) → skip + report.
 */
export function planWatch(queuedState, manifestByNum) {
  const nums = queuedNums(queuedState);
  const ready = [];
  const deferred = [];
  const invalid = [];
  const unresolvable = [];
  for (const num of nums) {
    const m = manifestByNum ? manifestByNum[num] : null;
    if (m == null) { unresolvable.push(num); continue; }
    const v = validateManifest(m);
    if (!v.ok) { invalid.push({ num, errors: v.errors }); continue; }
    const waitOn = (m.blockedBy ?? [])
      .map((n) => String(n).padStart(3, '0'))
      .filter((n) => isQueued(queuedState, n));
    if (waitOn.length === 0) ready.push(num);
    else deferred.push({ num, waitOn });
  }
  ready.sort((a, b) => a.localeCompare(b));
  return { ready, deferred, invalid, unresolvable };
}

// The WE derived-artifact regen set the drain reproduces ONCE at the end of a watch pass — the Phase 4c
// relocation (#2173): the same #1935 Fork-2 "regenerate-on-merge" generators the inline integrator ran
// (gen:inventory rebuilds the AGENTS.md inventory block; gen:reference-index rebuilds
// src/_data/referenceIndex.json). Lanes never commit these (they are derived), so the drain regenerates them
// once after the couples land rather than per-couple. Kept in lock-step with the orchestrator's 4c set.
export const DERIVED_REGEN = [
  ['npm', 'run', 'gen:inventory'],
  ['npm', 'run', 'gen:reference-index'],
];

// The exact files those generators write — the ONLY paths a post-land regen commit may carry. A regen commit
// must be scoped to these by an explicit pathspec, NEVER a bare `git diff --name-only` sweep: the drain runs in
// a checkout that can carry unrelated dirty tracked files (a concurrent session's in-flight claim), and a broad
// diff would sweep those FOREIGN edits into the "derived artifacts" commit and publish them (the shared-index
// commit race — same hazard `finalizeLand`'s explicit pathspec guards against). Kept in lock-step with
// DERIVED_REGEN above: one entry per generator's output.
export const DERIVED_OUTPUT_PATHS = ['AGENTS.md', 'src/_data/referenceIndex.json'];

/**
 * Decide the post-drain reconcile for a couple, from a drain-one result (#2175 reopen-on-fail). Pure — the
 * git/backlog actions are the CLI boundary. Returns `{ deleteManifest, reopen }`:
 *  - `deleteManifest` — the couple LANDED: its `.lane-manifest.json` rode the WE lane commit onto main, so the
 *    drain deletes it post-land (main carries no post-drain cruft; the manifest doc's "delete at landing").
 *  - `reopen` — the couple FAILED to land (a repo merge red, or the WE resolve is unreachable): the WE item is
 *    stranded `active` on main with no live session. Reconcile it `active→open` (the drain-side of the #2072
 *    closeout) so it honestly re-enters as not-being-worked — WHILE the queued marker + `lane/*` refs are
 *    PRESERVED (the drain never unqueues or deletes refs on failure), so the NEXT drain pass retries it.
 * A not-ready / dry-run / bad-input result reconciles nothing.
 */
export function planPostDrain(result) {
  const r = result || {};
  if (r.landed === true) return { deleteManifest: true, reopen: false };
  // Only a genuine land FAILURE reopens — not a defer (not-ready), a dry-run, or bad input (which never touched main).
  const failed = r.reason === 'merge-failed' || r.reason === 'resolve-unreachable';
  return { deleteManifest: false, reopen: failed };
}


// The drain must run in the WE checkout (it reads WE's queued.json + drives WE's backlog.mjs). Resolve WE's
// git toplevel from cwd and use it as the anchor for EVERY WE-side call — so the WE land targets the real WE
// repo even if invoked from a subdir, rather than silently relying on cwd == WE root (review #1).
function resolveWeRoot() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8' }).trim(); }
  catch { return process.cwd(); }
}

function runCli() {
  if (sub === 'watch' || sub === 'drain') return runWatch({ follow: sub === 'watch' });
  if (sub !== 'drain-one') {
    const detail = 'usage: `drain-one <NNN> --manifest=<path>` (land one queued couple) · `drain` (one cascade pass over the queue) · `watch` (poll + drain, --follow to keep waiting for producers)';
    if (flags.json) writeAllSync(1, JSON.stringify({ landed: false, reason: 'usage', detail }) + '\n');
    else process.stderr.write(`lane-drain ✗ usage: ${detail}\n`);
    process.exit(3);
  }
  return runDrainOne();
}

/**
 * Is a queued couple's WE resolve reachable on origin/main? Reads `status:` FRONTMATTER-strict from the
 * `origin/main:backlog/<num>-*.md` body — NOT a loose full-body regex (#2603). A backlog body can carry a
 * column-0 `status: resolved` (e.g. a fenced frontmatter example); a loose read makes an OPEN item look
 * resolved, and on the DRAIN (the merge path) that fails OPEN — a queued couple whose resolve did NOT flip
 * `status` could have its queued marker cleared on the strength of a prose example. This is the same spoof
 * class #2455 closed in lane-resume (`docIsResolved` / `resolvedOnMain`), now closed on the drain's reader too.
 *
 * @param {string|null} body  The `origin/main` file body, or `null` when it couldn't be fetched/shown.
 * @returns {boolean|null}  `true`/`false` from the frontmatter `status`; `null` when `body` is absent
 *   (couldn't determine — the caller treats null as advisory and still unqueues, false as a hard "not landed").
 *   Fails CLOSED on the same inputs the loose read did: no frontmatter / unparseable → `false`, never a spoofed
 *   `true`.
 */
export function resolveReachableFromBody(body) {
  return body != null ? readField(body, 'status') === 'resolved' : null;
}

function runDrainOne() {
  const AS_JSON = !!flags.json;
  const DRY_RUN = !!flags['dry-run'];
  const CWD = resolveWeRoot();

  function emit(result, code) {
    if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
    else process.stderr.write(`lane-drain ${result.landed ? '✓ landed' : result.reason === 'not-ready' ? '· not ready' : result.reason === 'dry-run' ? '· dry-run' : '✗ ' + (result.reason || 'failed')}: ${result.detail}\n`);
    process.exit(code);
  }

  if (!posNum) emit({ landed: false, reason: 'no-num', detail: 'pass the item number: drain-one <NNN> --manifest=<path>' }, 3);
  const num = String(posNum).padStart(3, '0');

  // WE-root sanity (review #1): CWD is the git toplevel; confirm it is actually the WE checkout (has pr-land
  // + the queued token) before landing, so a drain launched from the wrong repo fails loud, never lands WE
  // against a stranger.
  const queuedPath = resolve(CWD, '.claude/skills/batch-backlog-items/queued.json');
  try { readFileSync(resolve(CWD, 'scripts/pr-land.mjs'), 'utf8'); readFileSync(queuedPath, 'utf8'); }
  catch { emit({ landed: false, reason: 'not-we-root', detail: `cwd's git root (${CWD}) is not the WE checkout (no scripts/pr-land.mjs + queued.json) — run the drain from webeverything` }, 3); }

  // Load the manifest (caller-supplied path — discovery is the monitor's job, #2173).
  if (typeof flags.manifest !== 'string') emit({ landed: false, reason: 'no-manifest', detail: 'pass --manifest=<path to the item\'s .lane-manifest.json>' }, 3);
  let manifestText = '';
  try { manifestText = readFileSync(expandHome(flags.manifest), 'utf8'); } catch (e) { emit({ landed: false, reason: 'manifest-unreadable', detail: `cannot read --manifest=${flags.manifest} (${String(e.message || e).split('\n')[0]})` }, 3); }
  const manifest = parseManifest(manifestText);
  if (!manifest) emit({ landed: false, reason: 'manifest-invalid', detail: `--manifest=${flags.manifest} is not a valid manifest (unparseable JSON)` }, 3);

  // Read the current queued state (the #2161 token) offline.
  let queuedState;
  try { queuedState = parseQueued(readFileSync(queuedPath, 'utf8')); } catch { queuedState = parseQueued(''); }

  const plan = planDrain(manifest, queuedState);
  if (!plan.ok) emit({ landed: false, reason: 'plan-invalid', num, detail: plan.errors.join('; ') }, 3);
  if (!plan.ready) emit({ landed: false, reason: 'not-ready', num, waitOn: plan.waitOn, detail: `#${num} waits on unlanded queued dependency(ies): ${plan.waitOn.join(', ')} — defer (the monitor retries after they drain)` }, 0);

  // A body file is couple-wide — validate it up front (review #2), so a bad path fails BEFORE any repo
  // lands, never after a partial couple (which would need a #2175 reopen).
  const bodyFile = typeof flags['body-file'] === 'string' ? expandHome(flags['body-file']) : null;
  if (bodyFile) { try { readFileSync(bodyFile, 'utf8'); } catch { emit({ landed: false, reason: 'bad-body-file', num, detail: `--body-file=${flags['body-file']} is unreadable — fix it before draining (a couple-wide body must not fail mid-land)` }, 3); } }

  if (DRY_RUN) {
    const planLines = plan.steps.map((s) => {
      const rc = DRAIN_REPOS[s.repo];
      const rp = rc && rc.path ? expandHome(rc.path) : CWD;
      return `node ${buildPrLandArgs({ ref: s.ref, repoPath: rp, bodyFile, dryRun: true }).join(' ')}   # ${s.repo}${s.carriesResolve ? ' (carries resolve — lands LAST)' : ''}`;
    });
    emit({ landed: false, reason: 'dry-run', num, order: plan.steps.map((s) => s.repo), plan: planLines, detail: `would land #${num} across ${plan.steps.map((s) => s.repo).join(' → ')} (impl-first/WE-last), then unqueue` }, 0);
  }

  // Land each repo's ref in order; STOP at the first failure (impl-first/WE-last atomicity). Only after the
  // WE (resolve) ref lands do we unqueue — the single clear point (#2161).
  const landed = [];
  for (const step of plan.steps) {
    const repoCfg = DRAIN_REPOS[step.repo];
    const repoPath = repoCfg && repoCfg.path ? expandHome(repoCfg.path) : CWD; // WE = the resolved WE root (review #1), never implicit cwd
    const args = buildPrLandArgs({ ref: step.ref, repoPath, bodyFile });
    let res = null;
    try { res = JSON.parse(execFileSync('node', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
    catch (e) {
      // pr-land exits non-zero (red check / conflict / gh error) — its JSON is on stdout even then.
      try { res = JSON.parse(String(e.stdout || '').trim()); } catch { res = { merged: false, reason: 'pr-land-error', detail: String(e.message || e).split('\n')[0] }; }
    }
    if (res && res.merged) { landed.push(step.repo); continue; }
    // A repo failed → stop the couple here. WE never lands (if it was later), so the resolve never lands →
    // the item stays active/queued, never falsely resolved. REOPEN-ON-FAIL (#2175): reconcile the stranded WE
    // item active→open (keeping its queue marker + lane/* refs) so it honestly re-enters as not-being-worked.
    const reopen = reopenStrandedItem(CWD, num);
    emit({ landed: false, reason: 'merge-failed', num, stoppedAt: step.repo, landedRepos: landed, prLand: res, reopened: reopen.reopened, reopenPushed: reopen.pushed, detail: `#${num} stopped at ${step.repo}: ${res ? res.detail : 'no result'} — earlier repos landed [${landed.join(', ') || 'none'}]; item stays queued (re-drain after fix)${reopen.reopened ? ', reopened active→open (#2175)' : ''}. WE resolve NOT landed.` }, 2);
  }

  // Every repo landed (WE last) → confirm the WE resolve is reachable on origin/main, then clear the queued
  // marker. The resolve lives in backlog/<num>-<slug>.md; readResolveReachable finds the slug + reads `status:`
  // frontmatter-strict off the freshly-fetched origin/main.
  let resolveReachable = readResolveReachable(CWD, num);

  // #2748 — RESOLVE-ON-LAND: if the card is NOT already resolved after the WE merge (the producer did not
  // pre-author the flip), the DRAIN owns the flip NOW, off its terminal land event, then re-reads. WE-last
  // ordering means we only get here after impl merged, so this can never false-resolve a failed impl half
  // (#96). A flip that REFUSES (decision-needs-codifiedTo / epic-open-child / illegal status) leaves
  // resolveReachable false → the existing reopen-on-fail path below handles it exactly as before.
  // #2899 A2 — a `null` (couldn't tell) is NOT silently "do nothing". The old guard was
  // `if (resolveReachable === false)`, so the two distinct verdicts collapsed at the call site: a couldn't-tell
  // read skipped the flip with no attempt and no warning — and couldn't-tell was the NORMAL verdict for a
  // freshly JIT-numbered item, whose card A1 could not locate. Attempt the flip on `false` OR `null` and re-read:
  // the attempt is safe either way (an already-`resolved` card is an explicit no-op, and an illegal transition
  // REFUSES and leaves the reopen path below untouched), so trying on couldn't-tell can only turn an unknown
  // into a known. A `null` that SURVIVES the retry falls through to the advisory-proceed below, as before.
  let resolveOwnedByDrain = false;
  if (resolveReachable !== true) {
    const flip = resolveLandedItem(CWD, num);
    if (flip.flipped) { resolveOwnedByDrain = true; resolveReachable = readResolveReachable(CWD, num); }
    else if (flip.alreadyResolved) resolveReachable = readResolveReachable(CWD, num); // card is resolved locally — re-read main rather than trust the stale verdict
  }

  // Gate the single clear point on the resolve actually being on main (review #3): if the check is
  // EXPLICITLY false (WE merged but the resolve is somehow not reachable), do NOT unqueue — leave it queued
  // and exit 2 so the item re-drains / the #2175 reconcile handles it, never a false clear. A `null` (couldn't
  // determine — e.g. offline fetch) is advisory: proceed with the unqueue, since pr-land reported merged.
  if (resolveReachable === false) {
    // REOPEN-ON-FAIL (#2175): all refs merged but the resolve isn't reachable — treat as a failed land, leave it
    // queued (marker NOT cleared), and reconcile the stranded item active→open (queue + refs preserved).
    const reopen = reopenStrandedItem(CWD, num);
    emit({ landed: false, reason: 'resolve-unreachable', num, landedRepos: landed, resolveReachable, reopened: reopen.reopened, reopenPushed: reopen.pushed, detail: `#${num} merged all refs but its resolve is NOT reachable on origin/main — leaving it queued (re-drain)${reopen.reopened ? ', reopened active→open (#2175)' : ''}. Queued marker NOT cleared.` }, 2);
  }

  // SUCCESS reconcile (#2175): sync local main to the merged origin/main, then unqueue + delete the manifest it
  // carried, in one commit, and publish (the single clear point + main-cleanup, all post-land).
  const fin = finalizeLand(CWD, num);
  // The couple's own assigned NNN (if it was a provisional hash) + any leftover hashes numbered alongside.
  const numberedList = (fin.numbered && fin.numbered.committed) ? fin.numbered.assigned : [];
  const assigned = (numberedList.find((a) => a.hash === num) || {}).nnn || null;
  const alsoNumbered = numberedList.filter((a) => a.hash !== num);

  // #2748 — RELEASE-ON-LAND: with the couple landed + resolved + unqueued, hand its lane lease back in EVERY
  // pool it held. The item may have JIT-numbered from a hash (assigned) — release by the LANDED number the
  // owning session encodes (assigned ?? num), so a conveyor-<num> lease matches. Best-effort, post-land.
  const released = releaseItemLeases(CWD, assigned || num);
  const releasedCount = released ? released.released : 0;

  emit({ landed: true, reason: 'landed', num, assignedNum: assigned, alsoNumbered, landedRepos: landed, unqueued: fin.unqueued, manifestDeleted: fin.manifestDeleted, mainPushed: fin.pushed, resolveReachable, resolveOwnedByDrain, releasedLeases: releasedCount, detail: `landed #${num}${assigned ? ` → #${assigned} (JIT numbered)` : ''} across ${landed.join(' → ')} (impl-first/WE-last)${resolveOwnedByDrain ? ', resolve flipped by drain (#2748)' : ''}${fin.unqueued ? ', unqueued' : ' (unqueue failed — clear it manually)'}${fin.manifestDeleted ? ', manifest cleaned' : ''}${releasedCount ? `, released ${releasedCount} lease(s)` : ''}${alsoNumbered.length ? `, +${alsoNumbered.length} leftover(s) numbered (${alsoNumbered.map((a) => '#' + a.nnn).join(', ')})` : ''}${fin.pushed ? ', main published' : ''}` }, 0);
}

// ── watch/drain — the outer monitor loop (#2173) ───────────────────────────────────────────────────────
// Block the event loop for `sec` seconds without a busy-wait (follow mode's inter-poll sleep). A human
// Ctrl-Cs a `watch`; an automated caller bounds it with --max-idle.
function sleepSync(sec) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, sec) * 1000); } catch { /* env without SAB — skip the wait */ }
}

// Read the queued token offline (a corrupt/absent file degrades to an empty queue, never a crash).
function readQueued(queuedPath) {
  try { return parseQueued(readFileSync(queuedPath, 'utf8')); } catch { return parseQueued(''); }
}

// Read a queued item's manifest for its WE lane `ref` (the queued entry's `lane`). Returns a parsed manifest
// or null (no manifest anywhere → the item is `unresolvable`, skipped-and-reported by planWatch, never drained).
//
// xnsk54v — the manifest now rides the PR BODY (drain-only orchestration metadata belongs on the PR, not
// committed into the tree). Try the PR first via `gh pr list --head <ref>`; fall back to the legacy
// tree-committed `.lane-manifest.json` off the ref for lanes queued BEFORE the cutover (drop the tree fallback
// once the queue has fully turned over). Reading off an object/PR — never the working tree.
function readManifestFromPrBody(CWD, ref) {
  try {
    const out = execFileSync('gh', ['pr', 'list', '--head', ref, '--state', 'open', '--json', 'body'], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return extractManifestFromBody(JSON.parse(out)?.[0]?.body);
  } catch { return null; } // gh absent / no open PR for the ref / no block → fall through to the ref file
}

function readManifestOffRef(CWD, ref) {
  if (!ref) return null;
  const fromPr = readManifestFromPrBody(CWD, ref);
  if (fromPr) return fromPr;
  // Legacy fallback: the tree-committed manifest is a NEW file in the WE lane commit, not on main yet — fetch
  // the ref and read it out of the object.
  try { execFileSync('git', ['fetch', 'origin', ref, '--quiet'], { cwd: CWD, stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* best-effort; the ref may already be local */ }
  for (const rev of ['FETCH_HEAD', `origin/${ref}`, ref]) {
    try {
      const txt = execFileSync('git', ['show', `${rev}:${MANIFEST_FILENAME}`], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = parseManifest(txt);
      if (m) return m;
    } catch { /* try the next candidate rev */ }
  }
  return null;
}

// Drain ONE ready couple by spawning the drain-one subcommand (a fresh process per couple — drain-one owns the
// merge + single-clear-point and calls process.exit, so it cannot be re-entered in-process). Returns its JSON
// result (drain-one prints JSON to stdout even on a non-zero exit). This is the exact `lane-drain.mjs drain-one`
// invocation the item spec calls for.
function drainOneCouple(CWD, num, manifestPath, bodyFile) {
  const args = ['scripts/lane-drain.mjs', 'drain-one', num, `--manifest=${manifestPath}`, '--json'];
  if (bodyFile) args.push(`--body-file=${bodyFile}`);
  try {
    return JSON.parse(execFileSync('node', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  } catch (e) {
    try { return JSON.parse(String(e.stdout || '').trim()); } catch { return { landed: false, reason: 'spawn-error', detail: String(e.message || e).split('\n')[0] }; }
  }
}

// Regenerate the WE derived-artifact set ONCE (the Phase 4c relocation) after the couples land. Best-effort:
// a generator failure is reported, never fatal (the couples already landed; a stale derived artifact is a
// re-runnable follow-up, not a reason to unwind a green land).
function regenDerived(CWD) {
  const done = [];
  const failedGen = [];
  for (const cmd of DERIVED_REGEN) {
    try { execFileSync(cmd[0], cmd.slice(1), { cwd: CWD, stdio: ['ignore', 'ignore', 'pipe'] }); done.push(cmd.join(' ')); }
    catch (e) { failedGen.push({ cmd: cmd.join(' '), detail: String(e.message || e).split('\n')[0] }); }
  }
  return { done, failed: failedGen };
}

// A quiet, never-throwing git helper for the reconcile ops (best-effort — a failure is reported, never fatal:
// the LAND already succeeded/failed, and reconcile is cleanup on top of it).
function quietGit(CWD, a) {
  try { return execFileSync('git', a, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}

/** #2225 — the post-land heal/regen/numbering dirty-probe. These steps `git checkout --detach origin/main`
 *  and operate on POST-MERGE main, so untracked / git-ignored noise is irrelevant to their correctness — but
 *  a deps-symlinked lane clone (#2123, now the default solo-lane path) always carries an untracked
 *  `node_modules` SYMLINK (`.gitignore` has `node_modules/`, which matches a directory, not the symlink), so
 *  a bare `git status --porcelain` read as dirty and SKIPPED heal + regen on EVERY land from such a clone.
 *  Count only TRACKED modifications (which a detached checkout can carry over and wrongly sweep into the
 *  post-land commit); ignore untracked entries and any `node_modules` line. Feed it
 *  `git status --porcelain --untracked-files=no`. Pure. Shared single source (#2348) — pr-land.mjs
 *  re-exports this rather than forking its own copy; merge-ai-prs.mjs's JIT-numbering resync (below) uses it
 *  too, both via lane-drain.mjs (never a duplicate implementation, never a cross-import cycle). */
export function isPostLandTreeDirty(porcelainUntrackedNo) {
  return String(porcelainUntrackedNo || '')
    .split('\n')
    .some((l) => l.trim() !== '' && !/(^|[\s/])node_modules(\/|$|\s)/.test(l));
}

const QUEUED_REL = '.claude/skills/batch-backlog-items/queued.json';
// The hash→NNN ledger (#2288): the drain's local record of every hash it has already numbered, so a LATER
// couple that references an already-landed blocker by its old hash still resolves to the real number. Lives
// alongside the queued token — LOCAL-ONLY, gitignored drain state (Rule #105, like queued.json): it
// persists in the drain's checkout across invocations but never lands on main. APPEND-ONLY — it is never
// reset (a still-in-flight lane may reference a hash long before it is queued, so a queue-empty reset would
// drop a mapping a dependent still needs); entries are tiny, so unbounded growth is negligible.
const LEDGER_REL = '.claude/skills/batch-backlog-items/id-ledger.json';

/**
 * #4247 — the flow checker's own documented card-ref grammar (scripts/conveyor/flows/README.md: `"<card
 * id, e.g. #4140 or x1a2b3c>"`, enforced by `CARD_RE` in flow-model.mjs) accepts a NUMERIC ref only with a
 * leading `#`, but a HASH ref bare (no `#`, a hash needs no disambiguation). A flow file's `ack` value is
 * therefore authored bare while the card is still pending (`"no-owner": "xwo3j0l"`) — valid, since a bare
 * hash IS the documented form. The blind, generic hash→NNN swap `applyLedger` runs for every swept file
 * (backlog/, docs/agent/, agent-memory-src/, scripts/conveyor/flows/) never invents a character; it only
 * ever replaces the matched `xHASH` span, so a citation ALREADY written `#xHASH` in prose correctly becomes
 * `#NNN`, and a backlog `blockedBy` (never `#`-prefixed by that field's own separate contract) correctly
 * stays bare `NNN`. A flow `ack` value is the one place on the swept list authored bare but landing under a
 * grammar that requires `#` for the numeric form — so the very same swap that is correct everywhere else
 * produces an invalid bare `"4237"` here (main red, #4247: 68 `bad-ack`/rule findings, "is \"4237\", not a
 * card id (#NNNN or xHASH)"). Rather than teach the generic, file-type-blind `applyLedger` this ONE field's
 * grammar (or loosen the checker's documented, deliberate dual form), repair it narrowly, only on a file
 * this pass already rewrote, only inside that file's own `ack: {...}` spans (an ack value never contains a
 * literal `}`, so `[^}]*` cannot run past the block) — never touching a `cite`/line-number/notes digit
 * elsewhere in the same file, and never sweeping a flow file this pass did not otherwise touch.
 * @param {string} content  a `*.flow.json` file's raw text, POST the generic ledger swap
 * @returns {string}
 */
export function normalizeFlowAckCardRefs(content) {
  return content.replace(/"ack":\s*\{[^}]*\}/g, (block) => block.replace(/:(\s*)"(\d+)"/g, ':$1"#$2"'));
}

/**
 * Executable soak definitions mix live citations with historical hashes and fixture data. Only the
 * default export's literal `card` metadata is a numbering target. Parse without executing the module,
 * then edit that source span only: comments, nested `card` fields, templates in run(), fixedBy.where,
 * and fixture paths must survive byte-for-byte. Unsupported forms remain subject to the citation
 * backstop. Load the existing TS parser only when a definition actually contains a hash.
 */
function rewriteSoakCardCitation(content, visit) {
  if (!/\bx[0-9a-z]{6}\b/.test(content)) return content;
  const ts = createRequire(import.meta.url)('typescript');
  const source = ts.createSourceFile('break.mjs', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) return content;
  const spans = [];
  for (const statement of source.statements) {
    if (!ts.isExportAssignment(statement) || statement.isExportEquals || !ts.isObjectLiteralExpression(statement.expression)) continue;
    for (const property of statement.expression.properties) {
      if (!ts.isPropertyAssignment(property) ||
          !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) || property.name.text !== 'card') continue;
      const value = property.initializer;
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
        spans.push({ start: value.getStart(source) + 1, end: value.end - 1 });
      }
    }
  }
  for (const { start, end } of spans.reverse()) {
    content = content.slice(0, start) + content.slice(start, end).replace(/\bx[0-9a-z]{6}\b/g, visit) + content.slice(end);
  }
  return content;
}

/**
 * JIT numbering (#2288) — the one place a backlog id is minted. Numbers EVERY provisional (hash-keyed)
 * backlog file now present on main, not just the couple's own id: a landed lane can carry LEFTOVER items
 * scaffolded during close-out (born hash-keyed), and those need numbering too. A hash file only reaches
 * main via a landed lane (the sole-writer path), so sweeping all hash files touches only already-landed
 * content — never an item still in flight in another lane. Assigns DETERMINISTIC contiguous `max+1` in
 * topological (blockedBy) order — the drain is the sole SERIAL writer to main (#2290), so unlike scaffold's
 * randomized gap-fill (#2292, which only exists to stop PARALLEL births colliding) there is no collision to
 * avoid; max+1 keeps numbers contiguous (the #2288 "no burned gap numbers" goal). Records each `hash→NNN`
 * in the ledger, then blind-replaces EVERY ledgered hash across all `backlog/*.md` (filenames + contents),
 * `docs/agent/*.md` (#2428 — the cite-able STATUTE layer, e.g. platform-decisions.md, cites pending
 * hashes too; the same blind rewrite scope must cover it or a citation like "Build carried by #x…" dangles
 * permanently once the item lands with a real NNN, proven twice — repaired by hand in PR #408), AND
 * `agent-memory-src/*.md` (#3100 — the compiled agent-memory bundle every future session loads into
 * context; a dangling hash there is silently READ and misdirects every session from then on, not merely
 * discoverable like a stale backlog cross-ref), AND `scripts/conveyor/flows/*.flow.json` (#4075/xmd4pfa — a
 * flow's own `cite`s name a backlog file by its pre-numbering hash the same way a docs page does; without
 * this sweep the cite dangles the moment the card lands numbered, which is exactly how main's CI went red
 * — build-dispatch.flow.json's `backlog/xr05jjl-…` cite outlived the card's own rename to #4220), AND
 * `scripts/conveyor/soak/breaks/*.mjs` (ONLY the default export's literal `card` metadata, never executable
 * fixture data or historical hashes). Only tracked top-level definitions are swept, never nested fixtures or test files —
 * numbering each item AND repairing any cross-lane `blockedBy`/`parent`/`#ref` that still points at an
 * already-numbered blocker by its old hash.
 * Missing local mappings for explicit references fall back to bornAs on origin/main (#2903).
 * Unresolved references are warned and returned as `unresolvedReferences`, distinguishing visible
 * in-flight targets from potentially dead/unobservable targets. This does not change the numbering trigger.
 * Commits the rename+rewrites in ONE scoped commit; the caller publishes. Best-effort like the rest of the reconcile: a
 * failure is reported, the land stands.
 */
export function numberPendingHashes(CWD, { dryRun = false } = {}) {
  // Phase costs expose where the drain pass budget goes, including refused passes.
  const phaseMs = { read: 0, precheck: 0, resolve: 0, apply: 0, write: 0 };
  let phase = 'read';
  let phaseStart = performance.now();
  const nextPhase = (next) => {
    const now = performance.now();
    phaseMs[phase] += now - phaseStart;
    phaseStart = now;
    phase = next;
  };
  const finish = (result) => {
    nextPhase(phase);
    console.warn(`[numberPendingHashes] phaseMs ${Object.entries(phaseMs).map(([key, ms]) => `${key}=${ms.toFixed(2)}ms`).join(' ')}`);
    return { ...result, phaseMs };
  };
  const BL = join(CWD, 'backlog');
  const DOCS = join(CWD, 'docs', 'agent');
  const MEMORY = join(CWD, 'agent-memory-src');
  const FLOWS = join(CWD, 'scripts', 'conveyor', 'flows');
  const BREAKS = join(CWD, 'scripts', 'conveyor', 'soak', 'breaks');
  let stems;
  try { stems = readdirSync(BL).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')); }
  catch { return { assigned: [], committed: false, error: 'cannot read backlog/' }; }
  // Number only TRACKED hash files — a hash file reaches main solely via a landed lane, so it is committed.
  // An UNTRACKED hash `.md` in the checkout is local cruft (an uncommitted scaffold), NOT a landed item:
  // including it would make `git rm` fail and abort numbering for the real landed couple (PR #194 review).
  const trackedStems = new Set((quietGit(CWD, ['ls-files', 'backlog/*.md']) || '')
    .split('\n').filter(Boolean).map((f) => f.replace(/^backlog\//, '').replace(/\.md$/, '')));
  const pending = stems.filter((s) => isHash(idFromName(s)) && trackedStems.has(s)); // tracked hash files = landed in-flight items to number
  if (pending.length === 0) return { assigned: [], committed: false };

  // #2428 — extend the blind rewrite scope to the cite-able STATUTE layer (`docs/agent/*.md`): a doc like
  // platform-decisions.md cites a pending hash ("Build carried by #x…") the same way a backlog `blockedBy`
  // does, so it must get the same numbering pass or the citation dangles once the item lands numbered.
  // `name` for a docs entry is the FULL repo-relative path (incl. `docs/agent/` + `.md`) — unlike a backlog
  // stem (bare, no slash, no extension) — so the two can never collide; `pathFor` below tells them apart by
  // presence of `/`. Only TRACKED docs files are read/rewritten, same landed-only guard as backlog.
  let docsNames;
  try { docsNames = readdirSync(DOCS).filter((f) => f.endsWith('.md')); }
  catch { docsNames = []; } // docs/agent/ missing is not fatal — just nothing to sweep there
  const trackedDocs = new Set((quietGit(CWD, ['ls-files', 'docs/agent/*.md']) || '').split('\n').filter(Boolean));
  const docsFiles = docsNames
    .map((f) => `docs/agent/${f}`)
    .filter((rel) => trackedDocs.has(rel))
    .map((rel) => ({ name: rel, content: readFileSync(join(CWD, rel), 'utf8') }));

  // #3100 — extend the blind rewrite scope to `agent-memory-src/*.md`, the same way #2428 extended it to
  // `docs/agent/*.md`: the compiled agent-memory bundle every future session loads into context can cite a
  // pending hash ("filed #x…") exactly like a backlog `blockedBy` or a statute doc does, and without this a
  // citation there is left dangling permanently once the item lands numbered (a dead pointer READ, not just
  // discoverable, by every session from then on — the #3100 motivating instance). Same shape as docsFiles:
  // `name` is the full repo-relative path so `pathFor` below routes it via the same `includes('/')` branch
  // docs entries already use — no new path-resolution case needed. Only TRACKED files are read/rewritten.
  let memoryNames;
  try { memoryNames = readdirSync(MEMORY).filter((f) => f.endsWith('.md')); }
  catch { memoryNames = []; } // agent-memory-src/ missing is not fatal — just nothing to sweep there
  const trackedMemory = new Set((quietGit(CWD, ['ls-files', 'agent-memory-src/*.md']) || '').split('\n').filter(Boolean));
  const memoryFiles = memoryNames
    .map((f) => `agent-memory-src/${f}`)
    .filter((rel) => trackedMemory.has(rel))
    .map((rel) => ({ name: rel, content: readFileSync(join(CWD, rel), 'utf8') }));

  // #4075/xmd4pfa — extend the blind rewrite scope to `scripts/conveyor/flows/*.flow.json`: a flow file
  // cites a pending hash's backlog file BY NAME (`backlog/<hash>-slug.md:LINE`) the same way a docs page or
  // an agent-memory note cites one, and without this sweep that citation is left dangling permanently once
  // the item lands numbered — exactly the failure that turned main's CI red (build-dispatch.flow.json's
  // `backlog/xr05jjl-…` cite outliving the card's own rename to #4220). `readdirSync` here is deliberately
  // NON-recursive, so it sweeps only the top-level `<id>.flow.json` files, never `test-fixtures/**` — same
  // shape as docsFiles/memoryFiles: `name` is the full repo-relative path, so `pathFor` below routes it
  // through the same `includes('/')` branch with no new case needed. Only TRACKED files are read/rewritten.
  let flowsNames;
  try { flowsNames = readdirSync(FLOWS).filter((f) => f.endsWith('.flow.json')); }
  catch { flowsNames = []; } // scripts/conveyor/flows/ missing is not fatal — just nothing to sweep there
  const trackedFlows = new Set((quietGit(CWD, ['ls-files', 'scripts/conveyor/flows/*.flow.json']) || '').split('\n').filter(Boolean));
  const flowsFiles = flowsNames
    .map((f) => `scripts/conveyor/flows/${f}`)
    .filter((rel) => trackedFlows.has(rel))
    .map((rel) => ({ name: rel, content: readFileSync(join(CWD, rel), 'utf8') }));

  // Soak definitions carry live `card` citations too. Leaving these outside the rewrite set made the
  // unswept-citation backstop refuse EVERY numbering pass (2026-10-03 main CI incident). Keep that
  // backstop: teach the numberer this citation home, with the same tracked-only, non-recursive boundary
  // as flows. These are executable modules: rewrite only their citation metadata below, not their code.
  let breakNames;
  try { breakNames = readdirSync(BREAKS).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')); }
  catch { breakNames = []; }
  const trackedBreaks = new Set((quietGit(CWD, ['ls-files', 'scripts/conveyor/soak/breaks/*.mjs']) || '').split('\n').filter(Boolean));
  const breakFiles = breakNames
    .map((f) => `scripts/conveyor/soak/breaks/${f}`)
    .filter((rel) => trackedBreaks.has(rel))
    .map((rel) => ({ name: rel, content: readFileSync(join(CWD, rel), 'utf8') }));

  const files = [...stems.map((name) => ({ name, content: readFileSync(join(BL, `${name}.md`), 'utf8') })), ...docsFiles, ...memoryFiles, ...flowsFiles];
  const contentByName = new Map(files.map((f) => [f.name, f.content]));
  // Resolve a `files` entry's `name` to its on-disk absolute + commit-relative path — a backlog stem (bare,
  // no `/`) lives under `backlog/`; a docs entry (`name` already a full repo-relative path) lives as-is.
  const pathFor = (name) => name.includes('/')
    ? { absPath: join(CWD, name), relPath: name }
    : { absPath: join(BL, `${name}.md`), relPath: `backlog/${name}.md` };

  // Order the pending hashes TOPOLOGICALLY: a pending item whose blockedBy names ANOTHER pending hash is
  // numbered AFTER it (referenced item first, #2288). Cosmetic for correctness (applyLedger repairs every
  // ref regardless) but keeps assignment deterministic + contiguous by dependency depth. Grab blockedBy
  // hash tokens whether the YAML is flow-style (`[…]`) or block-style (`\n  - x…`) — the token pattern is
  // the same either way.
  const pendingHashes = new Set(pending.map(idFromName));
  const blockersOf = (stem) => {
    const m = contentByName.get(stem).match(/^blockedBy:\s*(\[[^\]]*\]|(?:\n[ \t]*-[ \t]*.+)+)/m);
    return m ? (m[1].match(/x[0-9a-z]{6}/g) || []).filter((h) => pendingHashes.has(h)) : [];
  };
  const ordered = [];
  const done = new Set();
  const remaining = [...pending].sort(); // stable base order
  while (remaining.length) {
    const i = remaining.findIndex((s) => blockersOf(s).every((h) => done.has(h)));
    const [stem] = i >= 0 ? remaining.splice(i, 1) : remaining.splice(0, 1); // cycle → break by taking the first
    ordered.push(stem); done.add(idFromName(stem));
  }

  // Assign contiguous max+1 in that order; record in the LOCAL ledger.
  let maxNum = stems.map(idFromName).filter(isNum).reduce((m, n) => Math.max(m, Number(n)), 0);
  const ledgerAbs = join(CWD, LEDGER_REL);
  let ledger = {};
  try { ledger = JSON.parse(readFileSync(ledgerAbs, 'utf8')) || {}; } catch { ledger = {}; }
  const assigned = [];
  for (const stem of ordered) {
    const hash = idFromName(stem);
    maxNum += 1;
    const nnn = String(maxNum).padStart(3, '0');
    ledger[hash] = nnn;
    assigned.push({ hash, nnn });
  }

  nextPhase('precheck');
  // Fail fast before reference walks: only newly ledgered hashes can block this drain pass.
  const remainingBreakCites = new Map();
  for (const { name, content } of breakFiles) {
    const rewritten = rewriteSoakCardCitation(content, (hash) => ledger[hash] ?? hash);
    remainingBreakCites.set(name, new Set(findHashPathCiteOutsideBacklog(rewritten, name).map((c) => c.hash)));
  }

  // #4075 follow-up (xmd4pfa, hardening after the build-dispatch.flow.json incident) — NEVER COMMIT A
  // RENAME THIS PASS CAN PROVE LEAVES A DANGLING CITATION. The dirs swept above (backlog/, docs/agent/,
  // agent-memory-src/, scripts/conveyor/flows/, scripts/conveyor/soak/breaks/) are a maintained list that can lag
  // a new citing file TYPE, exactly how `scripts/conveyor/flows/` itself lagged before this same incident
  // added it (a flow file cited `backlog/xr05jjl-….md`; the card landed as #4220; every PR's CI went red on
  // the 404'd path). Before writing or committing anything, re-check the REAL, WHOLE tracked tree — not just
  // the dirs this pass already knows to fix — for a file this pass CANNOT fix still citing one of THIS
  // pass's hashes by its file path. One `git grep` over the same HASH_PATH_CITE_SOURCE pattern check:standards'
  // own gate uses (scripts/lib/citation-check.mjs — one source of truth, never two independently-drifting
  // copies); repo-wide is still cheap (`--threads=1`, the #4166-measured win: a few tens of ms here).
  //
  // A hit outside this pass's own swept files means some file the sweep doesn't know how to fix would be
  // left pointing at a path that is about to stop existing — so this pass REFUSES to number ANY of its
  // pending hashes (fail closed, whole-pass, not a partial per-hash carve-out: committing SOME renames while
  // leaving others' cross-refs half-rewritten risks a new, harder-to-see inconsistency, and the existing
  // numbering-mutex-contention path above already defers the WHOLE pass on a lesser obstacle). The hash(es)
  // stay pending and are retried on the very next land — same shape as that mutex deferral.
  // Gate on THIS pass's own renames only — never the whole append-only ledger: a hash numbered in some past
  // pass stays in the ledger forever, and a stale historical mention of its path must not block every later
  // numbering (PR #2757 review).
  const sweptRelPaths = new Set(files.map((f) => pathFor(f.name).relPath));
  const renamingNow = new Set(assigned.map((a) => a.hash));
  let unsweptHashPathCites = [];
  try {
    const hits = execFileSync(
      'git', ['grep', '--threads=1', '-nE', HASH_PATH_CITE_SOURCE, '--', '.', ':!node_modules', ':!backlog'],
      { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 },
    ).split('\n').filter(Boolean);
    unsweptHashPathCites = findHashPathCitesInGrepLines(hits)
      // Soak modules are only partially swept: a repaired card field cannot hide a remaining
      // hash-path citation in code/comments (even the same hash on the same line).
      .filter((c) => renamingNow.has(c.hash) && (remainingBreakCites.has(c.file)
        ? remainingBreakCites.get(c.file).has(c.hash)
        : !sweptRelPaths.has(c.file)))
      .map((c) => ({ path: c.file, hash: c.hash }));
  } catch { /* git grep exits 1 on no match, or git unavailable — no findings either way, never abort on that alone */ }
  if (unsweptHashPathCites.length) {
    const detail = unsweptHashPathCites.map((f) => `${f.path} cites ${f.hash}`).join('; ');
    console.warn(`[numberPendingHashes] refusing this pass — a citation outside the rewrite scope would ` +
      `dangle post-rename: ${detail}. Widen the sweep scope (scripts/lane-drain.mjs#numberPendingHashes) or ` +
      `fix the citation, then this hash numbers on the next pass.`);
    return finish({ assigned: [], committed: false, error: `hash-path citation outside the rewrite scope: ${detail}` });
  }

  nextPhase('resolve');
  // Local bookkeeping cannot answer for another clone. Resolve explicit references through the
  // durable origin/main bornAs record before applying this clone's ledger (#2903).
  const unresolvedReferences = [];
  // One lazy bornAs scan replaces per-hash git startups within the drain pass budget.
  let bornAsNumbers = null;
  const landedNumbers = () => {
    if (bornAsNumbers) return bornAsNumbers;
    bornAsNumbers = new Map();
    try {
      const out = execFileSync('git', ['grep', '-E', '^bornAs: x[0-9a-z]{6}$', 'origin/main', '--', 'backlog/'],
        { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
      const seen = new Set();
      for (const line of out.split('\n')) {
        const match = line.match(/^origin\/main:(backlog\/.*):bornAs: (x[0-9a-z]{6})$/);
        if (!match || seen.has(match[2])) continue;
        seen.add(match[2]); // First path wins, even when its non-numeric stem yields no number.
        const number = match[1].match(/backlog\/(\d{1,5})-.*\.md$/);
        if (number) bornAsNumbers.set(match[2], number[1]);
      }
    } catch { /* best-effort — no origin/main or git failure means no landed mappings */ }
    return bornAsNumbers;
  };
  // #3383 perf — this used to answer "is `hash` visible on ANY ref" by building `visibleHashItems`
  // (a Set of every backlog file name on every ref) with ONE `git ls-tree -r -- backlog/` SUBPROCESS
  // PER visible ref (refs/heads/ + refs/remotes/), each one returning EVERY backlog filename at that
  // ref (thousands of lines). Fine on a fresh clone (a handful of refs); on a mature constellation clone
  // with 2000+ accumulated lane refs it is an O(refs) subprocess fan-out returning O(refs × backlog-size)
  // lines of text into Node — measured live (#3383) at 10-14 minutes wall-clock for a SINGLE numbering
  // pass that needed even one fallback resolve, vs the ~40-60s baseline for a pass that didn't (the
  // resident drain-daemon's own numbering-critical-section lock caught red-handed: held 4+ minutes,
  // CPU-bound, no visible child process — i.e. burning time re-parsing giant per-ref listings in JS, not
  // waiting on git itself).
  //
  // Replaced with ONE `git rev-list --objects <refs…> -- backlog/` walk. `rev-list` shares the graph
  // traversal across every ref given in a single argv (all these refs fork from the same overwhelmingly-
  // shared history), so the cost tracks the repo's total backlog/ history ONCE, not per ref — measured on
  // the live 2200+-ref clone: 4.9s total vs the prior O(refs) approach's 10+ minutes, and the output is
  // ~15k lines (the whole history) instead of ~9M (every ref's full current listing). Slightly more
  // inclusive than the old CURRENT-TREE-only check: a hash whose backlog file was later removed from
  // every ref's TIP but still sits somewhere in a ref's REACHABLE HISTORY now reads 'in-flight' where it
  // would have read 'unresolvable' before. That is the SAFE direction per this function's own contract two
  // lines up ("Absence is NOT proof of death") — erring toward "still might be alive" only ever DEFERS a
  // numbering decision, it never wrongly assigns one.
  const localHashStems = new Set(stems.map(idFromName).filter(isHash)); // this clone's own tree — free, no git call
  let refsCache = null;
  const listVisibleRefs = () => {
    if (!refsCache) refsCache = [...new Set((quietGit(CWD, ['for-each-ref', '--format=%(objectname)', 'refs/heads/', 'refs/remotes/']) || '').split('\n').filter(Boolean))];
    return refsCache;
  };
  let remoteHashSetCache = null; // built lazily ONCE per numberPendingHashes call, only if a fallback is ever needed
  const remoteVisibleHashes = () => {
    if (remoteHashSetCache) return remoteHashSetCache;
    remoteHashSetCache = new Set();
    const tips = listVisibleRefs();
    // Cache history across passes: deleted refs may retain diagnostic visibility (the safe direction).
    const enabled = process.env.WE_JIT_VISIBLE_HASH_CACHE !== '0';
    let cachePath = null;
    let cached = null;
    if (enabled) {
      try {
        cachePath = resolve(CWD, execFileSync('git', ['rev-parse', '--git-path', 'we-jit-visible-hashes.json'],
          { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
        const value = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (value.version === 1 && Array.isArray(value.tips) && Array.isArray(value.hashes) &&
          value.tips.every((tip) => typeof tip === 'string' && /^[0-9a-f]{40,64}$/.test(tip)) &&
          value.hashes.every((hash) => typeof hash === 'string' && isHash(hash))) cached = value;
      } catch { /* missing/corrupt cache falls back to the full walk */ }
    }
    const cachedTips = new Set(cached?.tips ?? []);
    const newTips = tips.filter((tip) => !cachedTips.has(tip));
    if (cached) {
      remoteHashSetCache = new Set(cached.hashes);
      if (!newTips.length) return remoteHashSetCache;
    }
    const walk = (args) => execFileSync('git', ['rev-list', '--objects', ...args, '--', 'backlog/'],
      { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    let out = '';
    try {
      if (tips.length) {
        if (cached) {
          try { out = walk([...newTips, '--not', ...cached.tips]); }
          catch { out = walk(tips); } // A cached tip may have been garbage-collected.
        } else out = walk(tips);
      }
    } catch { return remoteHashSetCache; } // Do not persist an incomplete walk.
    for (const line of out.split('\n')) {
      const sp = line.indexOf(' '); // bare `<sha>` (no space) = a commit/tree object, not a backlog file
      if (sp < 0) continue;
      const path = line.slice(sp + 1);
      if (!path.startsWith('backlog/')) continue;
      const id = idFromName(path.slice('backlog/'.length).replace(/\.md$/, ''));
      if (isHash(id)) remoteHashSetCache.add(id);
    }
    if (cachePath) {
      // Atomic replacement keeps interrupted drain passes from leaving a partial cache.
      const tmp = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ version: 1, tips, hashes: [...remoteHashSetCache] }) + '\n');
        renameSync(tmp, cachePath);
      } catch { /* cache writes are best-effort */ }
      finally { try { rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ } }
    }
    return remoteHashSetCache;
  };
  const resolveReference = (hash, name) => {
    if (ledger[hash] !== undefined) return hash; // the existing ledger pass owns this rewrite
    const landed = landedNumbers().get(hash) ?? null;
    if (landed !== null) return landed;
    // A visible provisional item is positive evidence of in-flight work. Absence is NOT proof
    // of death: another clone may have an unfetched/private branch. Surface that uncertainty.
    const visible = localHashStems.has(hash) || remoteVisibleHashes().has(hash);
    const status = visible ? 'in-flight' : 'unresolvable';
    if (!unresolvedReferences.some((r) => r.hash === hash && r.name === name)) {
      unresolvedReferences.push({ hash, name, status });
      console.warn(`[numberPendingHashes] ${name}: ${hash} ${status}` +
        (status === 'unresolvable' ? ' (no ledger, bornAs, or visible provisional item; potentially dead)' : ' (visible provisional item; left pending)'));
    }
    return hash;
  };
  const resolvedFiles = files.map(({ name, content }) => ({ name,
    content: mapHashReferences(content, (hash) => resolveReference(hash, name)),
  }));
  nextPhase('apply');
  // Only newly assigned items are stamped; fallback mappings never alter birth records or numbering.
  const { renames, rewrites, pathRenames } = applyLedger(resolvedFiles, ledger);
  // applyLedger compares against resolvedFiles, so retain fallback-only edits as well.
  const rewrittenNames = new Set(rewrites.map((r) => r.name));
  for (const file of resolvedFiles) {
    if (!rewrittenNames.has(file.name) && file.content !== contentByName.get(file.name)) rewrites.push(file);
  }
  // #4247 — repair a bare-digit `ack` value the swap above just produced (see normalizeFlowAckCardRefs'
  // own docblock) in every flow file THIS pass rewrote; never a repo-wide sweep for pre-existing staleness.
  for (const r of rewrites) {
    if (r.name.endsWith('.flow.json')) r.content = normalizeFlowAckCardRefs(r.content);
  }
  // Keep soak modules out of BOTH generic passes (fallback reference resolution and applyLedger,
  // including its path-renaming side effects). Old ledger entries are just as dangerous as new IDs:
  // 952011907 replaced the queue soak's historical HASH with its LANDED_NUM via an old ledger mapping.
  nextPhase('resolve');
  for (const { name, content } of breakFiles) {
    const rewritten = rewriteSoakCardCitation(content, (hash) => ledger[hash] ?? resolveReference(hash, name));
    if (rewritten !== content) rewrites.push({ name, content: rewritten });
  }

  nextPhase('apply');
  // #2400 — path-value refs are derived from UNTRUSTED backlog content, so CONFINE them to inside the repo
  // before acting: a crafted `relatedReport`/body token like `../../../outside/notes-<hash>.md` would
  // otherwise make `writeFileSync(join(CWD, to))` + `git rm from` write outside the tree and delete an
  // arbitrary file. Reject any absolute path or any token that escapes CWD after resolve (both `from` and
  // `to`), then keep only those whose file actually exists on disk (a bare URL / prose mention resolves to
  // no file and is a harmless no-op). Survivors get a `git rm` OLD + write-to-NEW + internal-ref rewrite below.
  const repoRoot = resolve(CWD);
  const inRepo = (p) => typeof p === 'string' && p !== '' && !isAbsolute(p) &&
    (resolve(CWD, p) === repoRoot || resolve(CWD, p).startsWith(repoRoot + sep));
  const livePathRenames = pathRenames.filter(({ from, to }) =>
    inRepo(from) && inRepo(to) && existsSync(join(CWD, from)));
  // #2319 — `number-stranded --dry-run`: report the planned mapping + renames without touching the tree/index.
  if (dryRun) return finish({
    assigned, committed: false, dryRun: true, unresolvedReferences,
    renamed: renames.map((r) => r.to),
    wouldRename: [...renames, ...livePathRenames].map((r) => ({ from: r.from, to: r.to })),
  });
  nextPhase('write');
  const rewriteByName = new Map(rewrites.map((r) => [r.name, r.content]));
  const renameFroms = new Set(renames.map((r) => r.from));
  // A rename is `git rm OLD` + write-to-NEW (NOT `git mv`): a scoped `git commit -- <paths>` is pathspec
  // mode (it errors on a rename staged in the index / the now-absent old path), but it DOES commit a
  // `git rm` deletion — the pattern finalizeLand uses for the manifest. `toAdd` = paths that EXIST on disk
  // (a `git add` of an already-rm'd old path errors and aborts the whole add); `commitPaths` also carries
  // the deleted old paths so the pathspec commit records the deletion (already staged by `git rm`).
  const toAdd = [];
  const commitPaths = [];
  for (const { name, content } of rewrites) {
    if (renameFroms.has(name)) continue; // a renamed file's content is written to its NEW path below
    const { absPath, relPath } = pathFor(name); // backlog stem → backlog/<name>.md; docs entry → its own full path (#2428)
    writeFileSync(absPath, content);
    toAdd.push(relPath); commitPaths.push(relPath);
  }
  for (const { from, to } of renames) {
    const content = rewriteByName.has(from) ? rewriteByName.get(from) : readFileSync(join(BL, `${from}.md`), 'utf8');
    writeFileSync(join(BL, `${to}.md`), content);
    if (quietGit(CWD, ['rm', '--quiet', `backlog/${from}.md`]) == null)
      return finish({ assigned, committed: false, error: `git rm ${from} failed` });
    toAdd.push(`backlog/${to}.md`);
    commitPaths.push(`backlog/${from}.md`, `backlog/${to}.md`);
  }
  // #2400 — rename each co-referenced ON-DISK file (a `relatedReport`, a body link to `reports/…-<hash>.md`)
  // whose stem embeds a numbered hash, and rewrite its internal self-refs (`/slice <hash>`, `#<hash>`) with
  // the same whole-ledger blind swap. Without this the item's rewritten ref dangles + the report is hidden →
  // the #2387 red-main regression. These paths live OUTSIDE `backlog/`, so `git rm` + write-to-new, not `git mv`.
  const ledgerEntries = Object.entries(ledger).filter(([h]) => isHash(h));
  for (const { from, to } of livePathRenames) {
    const content = swapHashes(readFileSync(join(CWD, from), 'utf8'), ledgerEntries);
    writeFileSync(join(CWD, to), content);
    if (quietGit(CWD, ['rm', '--quiet', from]) == null)
      return finish({ assigned, committed: false, error: `git rm ${from} failed` });
    toAdd.push(to);
    commitPaths.push(from, to);
  }
  // APPEND-ONLY — never reset. A lane can reference a hash while merely IN-FLIGHT (being worked), long
  // before it is queued, so resetting when the ready-to-merge queue drains would drop the mapping a
  // still-in-flight dependent needs → its edge would land as a dangling hash (PR #194 review, blocking).
  // Entries are tiny (`hash→NNN`); the ledger is LOCAL-ONLY, gitignored, machine-disposable drain
  // bookkeeping (Rule #105) that never lands on main, so unbounded growth is negligible (a TTL prune is a
  // possible future refinement, not a correctness need).
  writeFileSync(ledgerAbs, JSON.stringify(ledger, null, 2) + '\n');
  // DELIBERATELY does NOT also rewrite the conveyor's `.conveyor/queue.json` sidecar here (queue-store.mjs),
  // even though `assigned` is exactly the hash→NNN map a stale cleared-for-build row needs. Two reasons this
  // numbering commit stays read-only outside `backlog/` + its own local ledger:
  //   1. LAYERING — this function runs wherever a lane's WE half lands (any drain daemon host, any lane clone,
  //      possibly CI), but the conveyor sidecar is ONE machine-wide file in a specific operator's automation
  //      state home (`automation-home.mjs#automationStateRoot`, `CONVEYOR_STATE_ROOT`-pinnable). Coupling the
  //      numbering commit to that path would make drain correctness depend on conveyor state-root plumbing
  //      it has no other reason to know about, and would silently no-op (or write to the wrong root) on any
  //      host where they diverge — worse than doing nothing.
  //   2. SUFFICIENCY — resolution is fully recovered at READ TIME instead: `queue-store.mjs#bornAsIndexFromItems`
  //      + `#resolveBornAsRefs` map a stale hash row to its `bornAs`-stamped landed NNN on every read
  //      (`dispatch-plan.mjs`, `conveyor-state.mjs`), and `queue.mjs migrate-bornas` rewrites the on-disk
  //      sidecar itself the same way on demand. Both consume the SAME durable `bornAs:` stamp this function
  //      writes into the numbered card's frontmatter (`backlog/id.mjs#stampBornAs`) — so a stale row self-heals
  //      the next time anything reads or migrates the queue, with no write-side coupling and no missed case
  //      (a numbering commit made while the sidecar happens to be unreachable would otherwise silently drop
  //      the rewrite for good).
  quietGit(CWD, ['add', '--', ...new Set(toAdd)]); // stage rewrites + new renamed files (deletions already staged by git rm; ledger stays untracked)
  const paths = [...new Set(commitPaths)];
  const summary = assigned.map((a) => `${a.hash}→#${a.nnn}`).join(', ');
  const committed = quietGit(CWD, ['commit', '-m', assertNoClosingKeywordRef(`drain: JIT-number ${summary} at land (#2288)`, 'JIT-number commit message'), '--', ...paths]) != null;
  return finish({ assigned, committed, unresolvedReferences, renamed: [...renames, ...livePathRenames].map((r) => r.to), changedPaths: paths });
}

/**
 * xb94mt5 — cheap, git-only pre-check: does `CWD`'s tree carry ANY tracked provisional (hash-keyed) backlog
 * file right now? Mirrors the pre-check `scripts/lib/number-pending-hashes-before-push.mjs` already runs
 * before every push (same regex, same `git ls-files backlog/*.md` call) — kept as an independent, in-scope
 * copy here rather than importing that file, so this module never depends on a caller-side script. Lets a
 * caller that runs UNCONDITIONALLY once per pass (not gated on "did a WE PR merge THIS pass") skip the mutex
 * + the full `numberPendingHashes` corpus read entirely on the overwhelmingly common "nothing pending" tick.
 * @param {string} CWD
 * @returns {boolean}
 */
export function hasPendingHashFiles(CWD) {
  const tracked = quietGit(CWD, ['ls-files', 'backlog/*.md']);
  return tracked != null && /backlog\/x[0-9a-z]{6}-/.test(tracked);
}

/**
 * xb94mt5 — number (+ publish) whenever the refreshed tree carries a pending hash file, REGARDLESS of whether
 * THIS pass itself landed a WE PR. Audit finding A4 (we:reports/2026-09-24-daemon-blocking-antipatterns.md):
 * the JIT numbering in `scripts/merge-ai-prs.mjs` fires only when `landedLocal` is true (a WE PR merged this
 * pass), so a killed pass, a failed push, or a couple that landed via a non-WE-carrier path leaves a hash file
 * on main un-numbered until the next WE PR HAPPENS to land — and the resident drain daemon's own clone-refresh
 * `reset --hard` (against `#resident-daemon-reload-lifecycle` clause 4) discards any unpushed numbering commit
 * in between, so the miss can persist indefinitely rather than merely until the next merge.
 *
 * This is the SAME `numberPendingHashes` + numbering-mutex machinery `finalizeLand` uses (single source, never
 * a fork), wired to run on its own "is there anything to do" signal instead of a caller's landed-this-pass
 * flag — a caller (a drain pass's own top-of-loop, `push-if-green.mjs`'s pre-push hook, a cron sweep) can call
 * this UNCONDITIONALLY, every pass, and it is a true no-op (no git spawn beyond the one cheap `ls-files`, no
 * mutex acquisition) whenever {@link hasPendingHashFiles} finds nothing. xuqk1vp: never runs the write
 * unlocked — a live holder's pass simply finds nothing-to-do-yet and the NEXT pass's cheap check retries.
 * `lockOpts` passes through to {@link withNumberingLock} (e.g. `lockRoot`/`now`/`sleep`/`waitMs` for a test's
 * throwaway lock dir + fake clock) — never the mutex's OWN choice to run unlocked, which stays hard-`false`.
 * @param {string} CWD
 * @param {object} [lockOpts]
 * @returns {{ attempted: boolean, numbered?: {assigned: Array<{hash:string,nnn:string}>, committed: boolean}, pushed?: boolean, deferred?: boolean, heldBy?: string|null }}
 */
export function numberPendingHashesIfAny(CWD, lockOpts = {}) {
  if (!hasPendingHashFiles(CWD)) return { attempted: false };
  const numLock = withNumberingLock((heartbeat) => {
    const numbered = numberPendingHashes(CWD);
    heartbeat();
    const pushed = numbered.committed ? publishMain(CWD) : false;
    return { numbered, pushed };
  }, { ...lockOpts, runUnlockedOnContention: false });
  if (!numLock.ran) return { attempted: true, deferred: true, heldBy: numLock.heldBy ?? null };
  return { attempted: true, numbered: numLock.result.numbered, pushed: numLock.result.pushed };
}

/**
 * Resolve a birth-hash to the NNN it LANDED as, by reading the sole cross-clone proof-of-land: the
 * `bornAs:<hash>` line `numberPendingHashes` stamped into a numbered item's frontmatter on origin/main
 * (#2392). Returns the landed NNN string, or null when the hash has no bornAs record on main (it has not
 * landed). Unlike the local `id-ledger.json` — per-clone numbering bookkeeping, invisible to other
 * clones — this reads the SHARED main tree, so any clone can ask "did hash X land, and as what number?".
 * That is the durable, renumber-immune lookup the serial-batch→drain coordination gate (#2387) needs;
 * bornAs is derived from the ledger at land, so the two never disagree. Best-effort: a git failure (no
 * origin/main ref, no match) reads as "not landed" → null.
 * @param {string} hash  the item's birth hash (`x`+6 base36)
 * @param {string} [CWD]  a clone whose origin/main carries the landed backlog
 * @returns {string|null}
 */
export function landedNumberFor(hash, CWD = resolveWeRoot()) {
  if (!isHash(hash)) return null;
  // Whole-line match on origin/main so a longer token can never partial-hit; `-l` lists the matching
  // path(s) as `origin/main:backlog/NNN-slug.md` — the NNN in that path is the landed number.
  const out = quietGit(CWD, ['grep', '-l', '-E', `^bornAs: ${hash}$`, 'origin/main', '--', 'backlog/']);
  if (!out) return null;
  const line = out.split('\n').find(Boolean) || '';
  const m = line.match(/backlog\/(\d{1,5})-.*\.md$/);
  return m ? m[1] : null;
}

// Sync local main to the merged origin/main via a LOCAL fast-forward (never a work-merge — the couple's work
// is landed by pr-land, #2172 contract). `pull --ff-only` fetches + ff's the current branch; a non-ff / dirty
// collision aborts and we degrade gracefully (best-effort). Never touches a lane/* ref.
function syncMain(CWD) { quietGit(CWD, ['pull', '--ff-only']); }

// Publish local main to origin via the SANCTIONED gated-push helper (#2073) — never a raw git write of the
// branch (the #2172 contract: lane-drain re-uses the shared transports, never re-implements them). The
// couple's tree was just gated by pr-land's required CI, so `--assume-green` skips the redundant re-gate (the
// documented integrator path). ff-only inside the helper; a non-ff leaves origin untouched and is reported.
function publishMain(CWD) {
  try { const r = JSON.parse(execFileSync('node', ['scripts/push-if-green.mjs', '--assume-green', '--json'], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); return !!r.pushed; }
  catch (e) { try { return !!JSON.parse(String(e.stdout || '').trim()).pushed; } catch { return false; } }
}

// SUCCESS reconcile (#2175): the couple landed via PR onto ORIGIN/main, so sync local main to it, then UNQUEUE
// + DELETE the `.lane-manifest.json` it carried, in ONE commit, and publish. Best-effort at every step — a
// leftover manifest / un-pushed unqueue is recoverable cruft, never a reason to unwind a successful landing.
// `deps` is a test seam only (review #2668): `unqueue`/`publish` replace the backlog.mjs + push-if-green spawns,
// `lockOpts` points the numbering mutex at a throwaway lock root. Production calls pass nothing.
const unqueueViaBacklog = (CWD, num) => execFileSync('node', ['scripts/backlog.mjs', 'unqueue', num], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export function finalizeLand(CWD, num, { unqueue = unqueueViaBacklog, publish = publishMain, lockOpts = {} } = {}) {
  syncMain(CWD); // bring the merged origin/main (incl. the manifest the WE lane commit carried) local
  // Clear the queued marker (the single clear point) + stage the manifest deletion if it's tracked on main.
  let unqueued = false;
  try { unqueue(CWD, num); unqueued = true; } catch { unqueued = false; }
  let manifestDeleted = false;
  if (quietGit(CWD, ['ls-files', MANIFEST_FILENAME])) manifestDeleted = quietGit(CWD, ['rm', '--quiet', MANIFEST_FILENAME]) != null;
  // Commit ONLY this couple's paths via an explicit `-- <pathspec>` — a bare `git commit` would sweep any
  // foreign STAGED hunks (a concurrent session, a pre-staged tree) into the drain's commit and publish them
  // (the shared-index commit race). The pathspec form commits exactly these paths' index+worktree state (the
  // `git rm` deletion + the unqueue edit), ignoring the rest of the index — never `git add -A`.
  const commitPaths = manifestDeleted ? [QUEUED_REL, MANIFEST_FILENAME] : [QUEUED_REL];
  let pushed = false;
  const unqueueCommitted = quietGit(CWD, ['commit', '-m', assertNoClosingKeywordRef(`drain: unqueue + cleanup card ${num} lane manifest post-land (#2175)`, 'unqueue commit message'), '--', ...commitPaths]) != null;
  // JIT numbering (#2288): AFTER unqueue (so the ledger-reset check sees the emptied queue), number every
  // provisional hash file the couple landed — the couple's own hash AND any leftover items scaffolded in
  // its lane during close-out. A couple that carried no hash files (a legacy numeric item) is a no-op. The
  // single publish below pushes the unqueue commit and the numbering commit to main together.
  //
  // #2391 — number+publish is the NUMBERING CRITICAL SECTION (sole-serial-writer, #2288/#2290). Wrap it in the
  // TTL-bounded numbering mutex so two concurrent lands never both mint an NNN off the same base.
  //
  // xuqk1vp — `runUnlockedOnContention: false`: a live holder blocked past the budget means this section NEVER
  // runs unlocked (the old fallback let two writers race main; the #2318 tripwire only ever caught it AFTER the
  // damage). A refusal defers the NUMBERING this pass (`numLock.ran === false`) while the already-made unqueue
  // commit is still published below; #xb94mt5's pending-hash sweep (run at the top of every drain pass) numbers
  // the deferred hash file on the next pass, so nothing strands.
  // `heartbeat` is threaded through so a genuinely-long section (before #xn6n5gp's linear fix lands, or a slow
  // push) keeps its own lease fresh instead of racing the 5-minute TTL out from under itself.
  const numLock = withNumberingLock((heartbeat) => {
    const numbered = numberPendingHashes(CWD);
    heartbeat(); // refresh — numbering is the long pole; the push below should never find its own lease stale
    const pushed = (unqueueCommitted || numbered.committed) ? publish(CWD) : false;
    return { numbered, pushed };
  }, { ...lockOpts, runUnlockedOnContention: false });
  const fallback = { numbered: { assigned: [], committed: false }, pushed: false };
  const outcome = lockResultOr(numLock, fallback);
  const numbered = outcome.numbered;
  pushed = outcome.pushed;
  if (!numLock.ran) {
    // Review #2668 — only the NUMBERING is deferred. The unqueue+manifest commit above is already made and mints
    // no NNN, so publish it now (as the pre-lock code always did); otherwise origin keeps showing the couple
    // queued until some unrelated later push carries it. Best-effort: a non-ff push just reports pushed:false.
    // Tradeoff: this push is outside the section, so it can beat the holder's own push (which then fails non-ff
    // and is retried by the next pass's sweep). The pre-xuqk1vp code had the same exposure; it never mints an NNN.
    if (unqueueCommitted) pushed = publish(CWD);
    process.stderr.write(`lane-drain ⚠ #${num}: numbering mutex held by ${numLock.heldBy || '?'} — numbering DEFERRED this pass (#2391/#xuqk1vp), never run unlocked; the next pass's pending-hash sweep numbers it${unqueueCommitted ? ` (unqueue commit published: ${pushed})` : ''}\n`);
  }
  return { unqueued, manifestDeleted, pushed, numbered };
}

// FAILURE reconcile (#2175 reopen-on-fail): a couple that failed to land leaves the WE item STRANDED `active`
// on main with no live session. Flip it `active→open` (`release --force`) so it honestly re-enters as
// not-being-worked — release touches NEITHER the queued marker NOR the `lane/*` refs, so the couple stays
// queued with its durable refs for the NEXT drain pass to retry. Best-effort commit + publish of the flip.
function reopenStrandedItem(CWD, num) {
  syncMain(CWD); // reconcile against the merged state before reading/writing the item's status
  try { execFileSync('node', ['scripts/backlog.mjs', 'release', num, '--force'], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return { reopened: false, pushed: false }; } // not `active` (already open/resolved, or another session owns it) → leave it
  const path = (quietGit(CWD, ['ls-files', `backlog/${num}-*.md`]) || '').split('\n').filter(Boolean)[0];
  let pushed = false;
  if (path) {
    // Scope the commit to ONLY this item's backlog file (explicit `-- <path>`) — never a bare commit that would
    // absorb a foreign staged hunk (the shared-index commit race).
    if (quietGit(CWD, ['commit', '-m', assertNoClosingKeywordRef(`drain: reopen stranded card ${num} after failed land (#2175)`, 'reopen commit message'), '--', path]) != null) pushed = publishMain(CWD);
  }
  return { reopened: true, pushed };
}

// #2899 A1 — find an item's card in a git TREE (default the freshly-fetched `origin/main`), not in the local
// INDEX. `git ls-files` answers "what does THIS checkout track", which is the wrong question when the caller is
// trying to read main: a brand-new JIT-numbered file (#2288) has never existed in the local index under its
// `<NNN>` name, so `ls-files` returned nothing and every downstream read collapsed to "couldn't tell". Reading
// the tree asks the question the caller actually means. Pure-ish (one git read). Returns a repo-relative path
// or null.
export function cardPathInTree(CWD, num, { tree = 'origin/main', exec = null } = {}) {
  const tg = (a) => {
    const run = typeof exec === 'function' ? exec : execFileSync;
    try { return String(run('git', a, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) || '').trim(); } catch { return null; }
  };
  const listed = tg(['ls-tree', '--name-only', `${tree}:backlog`]);
  if (listed == null) return null;
  const prefix = `${num}-`;
  const hit = listed.split('\n').map((s) => s.trim()).filter(Boolean)
    .find((f) => f.endsWith('.md') && f.startsWith(prefix));
  return hit ? `backlog/${hit}` : null;
}

// #2748 — is the item's WE resolve reachable on origin/main RIGHT NOW? Fetches, finds the backlog file, reads
// `status:` FRONTMATTER-strict (via resolveReachableFromBody). Extracted so the drain can read it BEFORE and
// AFTER an on-land flip (below). Returns true/false, or null when the body can't be fetched (couldn't tell).
// #2899 A1 — the card is located via `cardPathInTree` (the origin/main TREE) rather than `git ls-files` (the
// local INDEX): for a freshly JIT-numbered item the `<NNN>`-named file is on main but was never in this
// checkout's index, so the index probe reported it absent and the caller silently skipped the flip.
function readResolveReachable(CWD, num) {
  const tg = (a) => { try { return execFileSync('git', a, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; } };
  tg(['fetch', 'origin', '--quiet']);
  const path = cardPathInTree(CWD, num);
  if (!path) return null;
  return resolveReachableFromBody(tg(['show', `origin/main:${path}`]));
}

// #2748 — RESOLVE-ON-LAND: the DRAIN owns the `active`/`open`→`resolved` card flip, hung off its terminal land
// event rather than depending on the producer having pre-authored it into the WE lane commit (the solo /pr,
// /finish, or missed-authoring case). Runs ONLY after every ref (impl-first, WE-last) has merged, so WE-last
// ordering still guarantees a failed impl half can never reach a resolve (#96). A card ALREADY `resolved` (the
// producer authored it — the prior common path) is a NO-OP; an `active`/`open` card is flipped via
// `backlog.mjs resolve` (legal from either — see applyTransition; a kind:decision missing --codified-to, or an
// epic with open children, correctly REFUSES → the caller falls back to the reopen path). Frontmatter-strict
// throughout (#2603). Mirrors reopenStrandedItem's transport: it runs in the drain's LANE clone, so the backlog
// write-guard permits the mutation (same as the reopen path). Best-effort. Returns { flipped, alreadyResolved }.
//
// #2899 A5 — EXPORTED, because there are TWO landers and only this one used to resolve. The LABEL lander
// (`we:scripts/merge-ai-prs.mjs` — the one the `/drain` skill actually runs) already single-sources this file's
// `numberPendingHashes`, but had no resolve at all: it assigned the NNN and never touched `status:`, which is
// why delivered work kept ranking Tier-A agent-ready and got re-packed. It now imports THIS function rather
// than forking one, so the flip has exactly one home no matter which drain lands the couple.
// The two options exist only because the two callers' transports differ; the DECISION logic is shared:
//   • `sync`    — lane-drain pulls merged origin/main before reading the card. The label lander has already
//                 synced (and holds an un-pushed numbering commit), so it passes `sync:false`.
//   • `publish` — lane-drain publishes each flip itself. The label lander passes `publish:false` so the flip
//                 commit rides the SAME `HEAD:main` push as the numbering commit it follows (one push, and no
//                 window where a numbered-but-unresolved card is on main).
export function resolveLandedItem(CWD, num, { sync = true, publish = true } = {}) {
  if (sync) syncMain(CWD); // reconcile against merged origin/main before reading/writing the card's status
  // The WORKING-TREE path is the right probe here (unlike readResolveReachable's tree read, #2899 A1): this
  // function READS and COMMITS the file in CWD, and post-numbering the index already carries the `<NNN>` name.
  const path = (quietGit(CWD, ['ls-files', `backlog/${num}-*.md`]) || '').split('\n').filter(Boolean)[0];
  if (!path) return { flipped: false, alreadyResolved: false };
  let body = null;
  try { body = readFileSync(join(CWD, path), 'utf8'); } catch { body = null; }
  if (body != null && readField(body, 'status') === 'resolved') return { flipped: false, alreadyResolved: true }; // producer authored it — nothing to do
  try { execFileSync('node', ['scripts/backlog.mjs', 'resolve', num], { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return { flipped: false, alreadyResolved: false }; } // illegal from-status / decision-needs-codifiedTo / epic-open-child / guard → leave it (caller reopens)
  // Scope the commit to ONLY this item's backlog file (explicit `-- <path>`) — never a bare commit that would
  // absorb a foreign staged hunk (the shared-index commit race, as finalizeLand/reopenStrandedItem guard).
  // #2899 jury J1 — `flipped` means "the flip is a COMMIT", not "the frontmatter splice returned 0". Returning
  // an unconditional `flipped: true` here made a failed commit read as a successful resolve at both call sites
  // (both branch on `flipped`), so the drain printed `✓ resolved on land … + pushed to main` while the card was
  // untouched on main — a silent false success on the sole writer to main, which is the exact failure class
  // #2899 was filed to close. An un-committed splice is a FAILURE: the working tree carries an edit nobody
  // asked for and main is unchanged, so the caller must be able to see it and say so.
  // #2779-incident — this WAS `drain: resolve #${num} on land (#2748)`. "resolve #N" is a GitHub
  // closing-keyword reference (see commit-message-safety.mjs), so pushing this exact commit for PR #2785's
  // (mis-derived) card 2779 auto-closed the real, unmerged PR #2779 as a side effect. `card ${num}` (no `#`
  // sigil on the item number) reads identically to a human and stays fully grep-able, but carries none of
  // GitHub's auto-close grammar. `assertNoClosingKeywordRef` is the runtime backstop against this recurring.
  const committed = quietGit(CWD, ['commit', '-m', assertNoClosingKeywordRef(`drain: mark card ${num} resolved on land (#2748)`, 'resolve-on-land commit message'), '--', path]) != null;
  if (committed && publish) publishMain(CWD);
  return { flipped: committed, alreadyResolved: false, committed, ...(committed ? {} : { reason: 'commit-failed' }) };
}

// #2748 — RELEASE-ON-LAND: hand the item's lane lease back to the pool in EVERY pool it was acquired in (a
// cross-locus couple holds a lane in the WE pool AND the impl pool), off the DRAIN's terminal land event. This
// is the UNIVERSAL cleanup point — it fires no matter WHO opened the PR (conveyor delivery agent, solo /pr,
// /finish), because the drain is the one serial merger common to every land path, so it kills the ghost-lane /
// wasted-re-dispatch family at its shared root (no longer hung off the delivery agent's exit or a conveyor-only
// watcher). Reuses lane-pool's by-ITEM sweep (#2748) — the drain has the item number, not the exact session
// slug. Best-effort: a release hiccup is reported, never unwinds a green land. Returns { released, pools } | null.
function releaseItemLeases(CWD, num) {
  const args = ['scripts/lane-pool.mjs', 'release', '--all-pools', `--item=${Number(num)}`, '--json'];
  try { return JSON.parse(execFileSync('node', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()); }
  catch (e) { try { return JSON.parse(String(e.stdout || '').trim()); } catch { return null; } }
}

function runWatch({ follow }) {
  const AS_JSON = !!flags.json;
  const DRY_RUN = !!flags['dry-run'];
  // Require an explicit `=N` value (a bare `--interval` sets flags.interval === true → would coerce to 1s).
  const interval = (typeof flags.interval === 'string' && Number(flags.interval) > 0) ? Number(flags.interval) : 30;
  // Idle polls to wait for NEW producer enqueues after the queue drains: follow (`watch`) waits forever by
  // default (a human Ctrl-Cs it); one-shot (`drain`) never waits. `--max-idle=N` bounds either (tests / cron).
  const maxIdle = typeof flags['max-idle'] === 'string' ? Number(flags['max-idle']) : (follow ? Infinity : 0);
  const bodyFile = typeof flags['body-file'] === 'string' ? expandHome(flags['body-file']) : null;
  const CWD = resolveWeRoot();
  const queuedPath = resolve(CWD, '.claude/skills/batch-backlog-items/queued.json');
  const log = (msg) => { if (!AS_JSON) process.stderr.write(`lane-drain · ${msg}\n`); };

  function fail(reason, detail, code) {
    if (AS_JSON) writeAllSync(1, JSON.stringify({ ok: false, reason, detail }) + '\n');
    else process.stderr.write(`lane-drain ✗ ${reason}: ${detail}\n`);
    process.exit(code);
  }

  // WE-root sanity (mirrors drain-one): the watch reads WE's queued.json + drives WE's drain-one, so a launch
  // from the wrong repo must fail loud, never poll a stranger's tree.
  try { readFileSync(resolve(CWD, 'scripts/pr-land.mjs'), 'utf8'); readFileSync(queuedPath, 'utf8'); }
  catch { fail('not-we-root', `cwd's git root (${CWD}) is not the WE checkout (no scripts/pr-land.mjs + queued.json) — run the drain from webeverything`, 3); }

  // #2391 — WHOLE-PROCESS DRAIN LEASE: at most one drain runs at a time. Acquire it for this run's full
  // lifetime; a second launch that finds a LIVE lease no-ops (its couples are already being landed), while a
  // STALE lease (a crashed drain) is reclaimed via the TTL. Heartbeated each pass; released at the end. A
  // DRY-RUN lands nothing, so it does NOT take the exclusive lease — it must be free to PLAN alongside a live
  // drain (and never block a real one launched right after it).
  // #3440 — keyed by THIS checkout's own repo identity, so a resident drain for a DIFFERENT project's checkout
  // on this machine never blocks (or falsely appears to cover) this WE-root run.
  const leaseOwner = drainOwner();
  const leaseRepoKey = localRepoSlug({ cwd: CWD });
  if (!DRY_RUN) {
    const lease = acquireDrainLease(DRAIN_LOCK_ROOT, leaseOwner, { repoKey: leaseRepoKey });
    if (!lease.ok) {
      const st = drainLeaseStatus(DRAIN_LOCK_ROOT, { repoKey: leaseRepoKey });
      if (AS_JSON) writeAllSync(1, JSON.stringify({ ok: true, mode: follow ? 'watch' : 'drain', skipped: 'drain-in-progress', heldBy: st.owner, detail: `another drain already holds the lease (${st.owner}) — no-op (#2391)` }) + '\n');
      else process.stderr.write(`lane-drain · another drain already running (lease held by ${st.owner || '?'}) — no-op (#2391)\n`);
      process.exit(0);
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'lane-drain-'));
  const landed = [];
  const failedCouples = [];
  const landedButQueued = []; // drain-one reported landed but its unqueue failed → item stuck in the queue (needs a manual clear); NEVER re-drained
  const attempted = new Set(); // couples this run already ran drain-one on — a hard guard so a land-but-unqueue-fail never re-drains an already-merged couple (the hot-loop hazard)
  let lastPlan = { ready: [], deferred: [], invalid: [], unresolvable: [] };
  let anyLanded = false;

  // One pass = read the queue, resolve each couple's manifest off its lane ref, plan, drain every READY couple
  // NOT YET ATTEMPTED this run. Cross-item CHAINS drain ACROSS passes (draining a head clears it from the
  // queue → the dependent is ready next pass), so this returns the count of NEW couples that landed this pass;
  // the caller loops while that is > 0. Progress is gated on a NEW couple landing, NOT on drain-one's `landed`
  // flag alone — a couple that lands but fails to unqueue stays in the queue, and the `attempted` guard stops
  // it re-planning as ready forever (the reviewed hot-loop hazard).
  function onePass() {
    const queuedState = readQueued(queuedPath);
    const manifestByNum = {};
    for (const q of queuedState.queued) manifestByNum[q.num] = readManifestOffRef(CWD, q.lane);
    const plan = planWatch(queuedState, manifestByNum);
    lastPlan = plan;
    if (plan.unresolvable.length) log(`unresolvable (no manifest on lane ref): ${plan.unresolvable.map((n) => '#' + n).join(', ')}`);
    if (plan.invalid.length) log(`invalid manifest (skipped): ${plan.invalid.map((i) => '#' + i.num).join(', ')}`);
    if (plan.deferred.length) log(`deferred (waits on unlanded dep): ${plan.deferred.map((d) => `#${d.num}→[${d.waitOn.join(',')}]`).join(', ')}`);
    const toDrain = plan.ready.filter((num) => !attempted.has(num)); // never re-attempt a couple in one run
    if (DRY_RUN) { log(`dry-run: would drain ${toDrain.map((n) => '#' + n).join(', ') || 'nothing'} (impl-first/WE-last per couple)`); return 0; }
    // xb94mt5 (review #2668) — the production caller of the any-pass sweep: number a hash file stranded by an
    // earlier killed/failed/deferred pass, whether or not anything merges this pass. A cheap `ls-files` no-op
    // when nothing is pending; never numbers unlocked (a live holder defers it to the next pass).
    // Only on `main`: on any other branch the pull would fast-forward THAT branch and the numbering commit would
    // land there, never on the main `publishMain` pushes.
    const onMain = quietGit(CWD, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'main';
    if (onMain) syncMain(CWD);
    const sweep = onMain ? numberPendingHashesIfAny(CWD) : { attempted: false };
    if (sweep.deferred) log(`pending-hash sweep deferred — numbering mutex held by ${sweep.heldBy || '?'}; retrying next pass`);
    else if (sweep.attempted && sweep.numbered.committed) log(`pending-hash sweep numbered ${sweep.numbered.assigned.map((a) => `${a.hash}→#${a.nnn}`).join(', ')} (published: ${sweep.pushed})`);
    let landedThisPass = 0;
    for (const num of toDrain) {
      // #2453 — heartbeat PER COUPLE, not just at the top of the pass: a one-shot sweep with several queued
      // couples can run well past the lease TTL before its single pass even finishes (each couple lands via
      // pr-land, which itself waits on GitHub's required checks), so refreshing the lease only between passes
      // lets it go stale mid-sweep — a concurrent drain would then reclaim it, reopening the #2424
      // double-drain window for any sweep longer than the TTL. Heartbeating before each couple keeps a live,
      // still-running sweep's lease fresh no matter how long the pass takes.
      if (!DRY_RUN) heartbeatDrainLease(DRAIN_LOCK_ROOT, leaseOwner, { repoKey: leaseRepoKey });
      attempted.add(num);
      const mpath = join(tmpDir, `${num}.lane-manifest.json`);
      writeFileSync(mpath, JSON.stringify(manifestByNum[num], null, 2));
      const res = drainOneCouple(CWD, num, mpath, bodyFile);
      if (res && res.landed) {
        landed.push(num); anyLanded = true; landedThisPass++;
        if (res.unqueued === false) { landedButQueued.push(num); log(`⚠ landed #${num} but its unqueue FAILED — still in the queue; clear it manually (won't re-drain)`); }
        else log(`✓ landed #${num}`);
      } else {
        failedCouples.push({ num, reason: res ? res.reason : 'spawn-failed', detail: res ? res.detail : '' });
        log(`✗ #${num} not landed (${res ? res.reason : 'spawn-failed'}) — left queued (${res ? res.detail : ''})`);
      }
    }
    return landedThisPass;
  }

  let idlePolls = 0;
  for (;;) {
    if (!DRY_RUN) heartbeatDrainLease(DRAIN_LOCK_ROOT, leaseOwner, { repoKey: leaseRepoKey }); // #2391 — keep the whole-process lease alive across a long watch (#3440 repoKey selects the same per-repo lock dir)
    const n = onePass();
    if (n > 0) { idlePolls = 0; continue; } // a NEW couple landed — re-poll immediately (a landed head may free a dependent)
    if (idlePolls >= maxIdle) break;         // drained/stuck and no more idle budget → done
    idlePolls++;
    log(`queue drained/stuck — idle poll ${idlePolls}${maxIdle === Infinity ? '' : `/${maxIdle}`} (sleeping ${interval}s for new producer enqueues; Ctrl-C to stop)…`);
    sleepSync(interval);
  }

  // Regenerate WE derived artifacts ONCE at the end of the run (the Phase 4c relocation) — only if something
  // landed and we are not dry-running.
  let derived = { done: [], failed: [] };
  if (anyLanded && !DRY_RUN) {
    log(`regenerating WE derived artifacts once (${DERIVED_REGEN.map((c) => c.join(' ')).join(', ')})…`);
    derived = regenDerived(CWD);
    if (derived.failed.length) log(`⚠ derived regen partial: ${derived.failed.map((f) => f.cmd).join(', ')} failed — re-run by hand`);
  }

  // Clean up the per-run temp dir (the manifests handed to drain-one) — no orphaned tmp cruft.
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  // The honest completion signal is the QUEUE ITSELF: did everything drain? A non-empty queue at exit — a
  // failed couple, an invalid/unresolvable manifest, a couple that landed-but-didn't-unqueue, or a
  // permanently-deferred item whose blocker never landed — means the drain did NOT fully clear the queue, so
  // it must NOT report success (the reviewed stuck-queue-exits-0 defect). Read the post-run queue as truth
  // rather than trusting the in-loop flags. (A dry-run never mutates the queue, so it always exits 0.)
  const remainingQueue = DRY_RUN ? [] : queuedNums(readQueued(queuedPath));
  const fullyDrained = remainingQueue.length === 0;

  const result = {
    ok: true,
    mode: follow ? 'watch' : 'drain',
    dryRun: DRY_RUN,
    convergenceLoop: convergeSwitch(), // #2410 slice D — off-by-default; observable in the drain result (loop execution graduates per-repo)
    fullyDrained,
    landed,
    landedButQueued,
    failed: failedCouples,
    deferred: lastPlan.deferred,
    invalid: lastPlan.invalid,
    unresolvable: lastPlan.unresolvable,
    remainingQueue,
    derivedRegenerated: derived.done,
    derivedFailed: derived.failed,
    detail: `${DRY_RUN ? 'dry-run: ' : ''}landed ${landed.length} couple(s)${landed.length ? ` (${landed.map((n) => '#' + n).join(', ')})` : ''}${failedCouples.length ? `, ${failedCouples.length} failed (left queued)` : ''}${landedButQueued.length ? `, ${landedButQueued.length} landed-but-not-cleared` : ''}${lastPlan.deferred.length ? `, ${lastPlan.deferred.length} deferred` : ''}${!DRY_RUN && !fullyDrained ? `, ${remainingQueue.length} still queued` : ''}`,
  };
  if (!DRY_RUN) releaseDrainLease(DRAIN_LOCK_ROOT, leaseOwner, { repoKey: leaseRepoKey }); // #2391 — free the whole-process lease for the next drain launch
  if (AS_JSON) writeAllSync(1, JSON.stringify(result) + '\n');
  else process.stderr.write(`lane-drain ${follow ? 'watch' : 'drain'} ${fullyDrained ? '✓' : '⚠'} ${result.detail}\n`);
  // Exit 0 ONLY when the queue fully drained (nothing left needing attention); else 2. A dry-run reports 0
  // (it plans, never drains) — its plan is in the JSON.
  process.exit(DRY_RUN || fullyDrained ? 0 : 2);
}

// Allow importing the pure helpers without running the CLI (the test file imports this module). Kept LAST (review
// #2668): the CLI runs synchronously, so invoking it any earlier leaves the module-level constants declared below
// that point (QUEUED_REL, LEDGER_REL, …) in their temporal dead zone — `finalizeLand`/`numberPendingHashes` then
// threw `Cannot access 'LEDGER_REL' before initialization` on every real CLI numbering path.
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) runCli();
