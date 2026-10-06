#!/usr/bin/env node
/**
 * @file scripts/conveyor/pr-watch.mjs
 * @description The CONVEYOR MERGE WATCHER (WE #2608, epic #2612). A throwaway background process, ONE per
 *   in-flight PR: it polls `gh pr view <N> --json state,mergedAt,labels` on a fixed interval and EXITS the
 *   instant the PR reaches a terminal-for-the-conveyor state — MERGED (the resident drain daemon landed it) or
 *   PARKED (an escalation the main session must handle). The process EXIT is the wake signal: the conveyor
 *   skill (#2613) spawns this in the background, so its exit rides the task-notification wake path and the main
 *   session is woken INSTANTLY — no in-session polling, no push seam — and re-dispatches into the freed lane
 *   the same turn. The exit CODE tells the skill which happened (merged vs parked vs timeout).
 *
 * EVENT-DRIVEN LAND (WE #2683). Besides watching for the terminal state, this watcher also closes the daemon-side
 * LAND-TRIGGER gap: the resident drain daemon lands a ready PR only on its next ≤60s poll, so a PR that becomes
 * landable right after a sweep waits up to a full interval. On the false→true transition of {@link isReadyToLand}
 * — CI-green AND the non-author review sign-off both present, firing on whichever completes LAST — the watcher
 * shells the daemon's OWN land path scoped to one PR (`merge-ai-prs.mjs --only=<pr> --label=ready-to-merge`) so
 * the PR lands at once. The fast drain is NOT a caller-trusted shortcut: it re-derives the full pre-land gate
 * server-side (review sign-off, required check, mergeable), runs the identical `planLabelDrain` blockedBy /
 * impl-first ordering, and serializes its `gh pr merge` under the drain's serial-writer mutex + a per-PR
 * idempotency guard — so an early or spurious fire is a safe no-op and a concurrent daemon sweep never
 * double-merges. Best-effort: a fire failure just falls back to the daemon's ≤60s sweep. Disable with
 * `--no-fast-drain`.
 *
 * ON-LAND CLEANUP (the drain-side, session-free post-merge passes). On a MERGE exit this watcher runs the
 * cleanup that must leave the session (epic #2753's "a session does only queue + expose-state"): (a) the
 * #2667/#2700 lease-release across pools ({@link releaseSessionAcrossPools}, opt-in via `--release-session`),
 * and (b) #2752 epic-resolve-on-last-child ({@link resolveEpicOnLand}) — when the child story this PR
 * delivered was its parent epic's LAST open child, it resolves the umbrella (`graduatedTo: none`) via
 * `backlog.mjs resolve-parent` and lands the splice on the SANCTIONED gated `push-if-green` transport. Both
 * are best-effort and NEVER change the merge exit code. The child ref for (b) rides the existing
 * `--release-session=conveyor-<ref>` wire (or an explicit `--resolve-epic-of=<ref>`); disable with
 * `--no-resolve-epic`. A blocked/untriaged epic is ESCALATED (logged for the operator), never auto-closed.
 *
 * Scripted per [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment] (#2607): the
 * state→decision rule is script-decidable (a gh PR json → one of three verdicts), so it lives here as a PURE,
 * unit-tested function — never a policy the conveyor skill re-derives in prose each tick.
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors the sibling readiness scripts, e.g. conveyor-state.mjs #2611):
 *   • The PURE core ({@link classifyPr}) has NO gh / child_process / clock — it takes an ALREADY-PARSED gh PR
 *     object and returns `'merged' | 'parked' | 'pending'`. It is unit-tested directly against fixtures
 *     (scripts/conveyor/__tests__/pr-watch.test.mjs) with zero network / gh.
 *   • The IO SHELL (the `main()` CLI, gated on the main-module check) owns the `gh` poll, the interval sleep,
 *     the wall-clock deadline, and the exit code. It calls the pure core on each poll and maps its verdict to
 *     the exit contract below.
 *
 * THE EXIT CONTRACT (the conveyor skill reads process.exitCode as the outcome — keep these stable):
 *   • {@link EXIT_MERGED} (0)   — the PR MERGED. The lane it was on is now free; the skill re-dispatches into it.
 *   • {@link EXIT_PARKED} (2)   — the PR PARKED for review: it carries `review:human` / `review:pending` /
 *                                 `review:changes`. Terminal for the watcher — the main session handles it by
 *                                 running /review on the (still-OPEN) parked PR.
 *   • {@link EXIT_TIMEOUT} (3)  — the wall-clock deadline elapsed while the PR was still PENDING (never reached
 *                                 a terminal state). The skill re-arms a watcher or investigates a stuck lane.
 *   • {@link EXIT_CLOSED} (4)   — the PR was CLOSED without merging (a human abandoned it). Terminal, and kept
 *                                 DISTINCT from a review park (exit 2) precisely so the skill can branch: on 4 it
 *                                 investigates the abandoned lane; it does NOT run /review (a review-label swap
 *                                 cannot land a closed PR). One integer per action — exit 2 and exit 4 never mix.
 *   • {@link EXIT_ERROR} (1)    — bad arguments (no PR number). A per-poll `gh` failure is NOT this: it is logged
 *                                 and retried until the deadline (a transient gh hiccup must not kill the watch),
 *                                 so a permanently-unreadable PR surfaces as EXIT_TIMEOUT, not a crash.
 *
 * NOT WATCHER-VISIBLE — RED CI / GATE-RED. The classifier reads ONLY `state,mergedAt,labels`; it cannot see a
 * red `test` check. A gate-red / red-CI escalation leaves the PR OPEN + UNLABELLED, which classifies as
 * `pending` (correct — CI may still be running, and the drain's ci-lifecycle reconcile owns the red-CI label).
 * Red-CI escalation is surfaced by the DELIVERY AGENT's one-line escalation RETURN (the #2608 brief, step 7 /
 * Escalations), NOT by this watcher — never assume the watcher catches red CI.
 *
 * UPGRADE SEAM (#2605 — a CONSUMER upgrade, not a blocker). The gh-poll loop in {@link watchPr} is deliberately
 * isolated behind the injected `pollOnce`, so once #2605 lands the daemon's nudge/SSE push seam this internal
 * poller can be swapped for a single blocking call to `plateau:tools/drain-daemon/cli.mjs watch --pr <N>` —
 * WITHOUT changing the pure {@link classifyPr} verdicts or the exit contract above. The daemon's blocking watch
 * would replace the poll+sleep only; this file stays the stable interface the conveyor skill spawns. See the
 * marked seam in {@link watchPr}.
 */

// ── PURE CORE (no gh / child_process / clock — the gh PR object is passed IN) ─────────────────────────────────

// The SHARED required-check selector (#xkfv491). Imported rather than re-derived so the fast-land trigger and
// the lander can never disagree about which rollup entry is "the" check — the split this watcher's docstring
// used to *claim* was closed while a local `.find(...)` quietly held the opposite rule. `merge-ai-prs.mjs` has
// no module-scope side effects (its CLI is behind an `IS_CLI` guard) and does not import this file, so there is
// no cycle and no daemon-startup cost: importing it measures the same ~50ms as importing this file alone.
import { readGh } from '../lib/proc-read.mjs';
import { latestRequiredCheck } from '../merge-ai-prs.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

/** The review labels that mark an OPEN PR as PARKED for human review — the main session runs /review to clear
 *  them. The drain daemon applies `review:human`/`review:pending` on escalation; `review:changes` is included
 *  because a human bounced a prior diff and (on the re-dispatch path) pr-land can update a `lane/<num>` PR that
 *  still carries a stale `review:changes` — it must surface as parked at once, not poll to timeout. */
export const PARK_LABELS = Object.freeze(['review:human', 'review:pending', 'review:changes']);

/** The exit-code contract (see the file header). Exported so a test / the conveyor skill can reference them by
 *  name rather than a magic number. */
export const EXIT_MERGED = 0;
export const EXIT_PARKED = 2;
export const EXIT_TIMEOUT = 3;
export const EXIT_CLOSED = 4;
export const EXIT_ERROR = 1;

/** Normalize a gh `labels` array to a plain lowercased name list. gh emits `[{name}]`; tolerate a bare-string
 *  array too (mirrors conveyor-state.mjs `shapePrs`). */
function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter(Boolean)
    .map((n) => String(n).toLowerCase());
}

/**
 * The DETERMINISTIC watcher verdict — the pure keystone. Same gh PR json → same verdict, always.
 *
 * Precedence (terminal states win over pending; MERGED wins over a stray park label):
 *   1. MERGED  — `state === 'MERGED'` OR `mergedAt` is set. The drain landed it; the lane is free.
 *   2. CLOSED  — `state === 'CLOSED'` with no `mergedAt`: a human abandoned the PR without merging. Terminal,
 *                and DISTINCT from a review park — checked BEFORE the park label so a closed PR that still
 *                carries a stale `review:*` label reads as `closed` (the skill investigates the abandoned lane),
 *                never `parked` (running /review on a closed PR is meaningless — the label swap can't land it).
 *   3. PARKED  — an OPEN PR carrying a park label (`review:human` / `review:pending` / `review:changes`). The
 *                main session runs /review to clear it. Terminal for the watcher.
 *   4. PENDING — none of the above: an open PR still in flight (green-and-queued, CI running, or a plain open
 *                PR the drain hasn't reached — note a red `test` check is UNLABELLED and lands here, correctly;
 *                red-CI escalation is the delivery agent's return, not the watcher — see the file header). Keep
 *                polling.
 *
 * @param {{state?:string, mergedAt?:string|null, labels?:Array<{name?:string}|string>}|null|undefined} pr
 *   the parsed `gh pr view --json state,mergedAt,labels` object.
 * @returns {'merged'|'closed'|'parked'|'pending'}
 */
export function classifyPr(pr) {
  if (!pr || typeof pr !== 'object') return 'pending'; // no data parsed yet → keep waiting (never a false exit)
  const state = String(pr.state || '').toUpperCase();
  if (state === 'MERGED' || pr.mergedAt) return 'merged';
  if (state === 'CLOSED') return 'closed'; // abandoned unmerged — terminal & DISTINCT from a review park
  const labels = labelNames(pr.labels);
  if (labels.some((l) => PARK_LABELS.includes(l))) return 'parked';
  return 'pending';
}

/** The required check's conclusion is SUCCESS on this PR's rollup? Reads the check through the drain's OWN
 *  shared selector ({@link latestRequiredCheck}) rather than a local lookup, so the trigger and the lander read
 *  "green" identically BY CONSTRUCTION — including #xkfv491's latest-run-wins rule (a head SHA routinely carries
 *  a concurrency-CANCELLED run beside the SUCCESS that actually finished) and its CheckRun-over-StatusContext
 *  preference. This file previously re-derived the lookup with `roll.find(...)`, i.e. the FIRST entry by name,
 *  so the parity this docstring claims was false for exactly the superseded-run PRs the fast land exists for.
 *  Other checks (cla, Workers Builds) are ignored. Pure — the parsed `statusCheckRollup` is passed in. A MISSING
 *  required check reads as NOT green (in-flight), never a false green. */
export function isRequiredCheckGreen(pr, requiredCheck = 'test') {
  const check = latestRequiredCheck(pr, requiredCheck);
  if (!check) return false;
  return String(check.conclusion || check.state || '').toUpperCase() === 'SUCCESS';
}

/** Is the non-author review sign-off PRESENT (GitHub branch-protection `reviewDecision`)? Pure. `APPROVED` → yes;
 *  an EMPTY/absent decision → the repo requires no review, so "present" (nothing to wait on); `REVIEW_REQUIRED` /
 *  `CHANGES_REQUESTED` → NOT present (a required approval is still missing / was refused). This is the SERVER
 *  truth the drain's `gh pr merge` ultimately enforces via branch protection — the trigger reads it so it fires
 *  on the review sign-off arriving, not just on CI going green (#2683 round-2). */
export function isReviewSignedOff(pr) {
  const d = String(pr?.reviewDecision || '').toUpperCase();
  if (d === '' ) return true;               // no review required by branch protection → nothing to wait on
  return d === 'APPROVED';                    // an explicit non-author approval landed
}

/**
 * #2683 — is this PR READY TO LAND right now, i.e. has the LAST of its landing preconditions completed? Pure.
 * The fast-drain trigger fires on the false→true transition of THIS predicate, so it fires on whichever of
 * {CI-green, review-sign-off} lands LAST — closing round-2's "green-only trigger fires before the sign-off, no-ops,
 * and never re-fires" gap. A PR is ready-to-land iff ALL hold:
 *   - it is OPEN (not merged/closed — those are terminal, nothing to trigger);
 *   - it carries NO uncleared review PARK label (`review:human/pending/changes`): a parked PR is the watcher's
 *     `parked` exit + a human `/review`, never a fast-drain (defensive — the loop checks `classifyPr` first anyway);
 *   - the required check is GREEN; AND
 *   - the non-author review sign-off is PRESENT.
 * The fast-drain itself re-derives every one of these SERVER-SIDE before it merges (it never trusts this
 * assertion — #2683 AC2), so a false-positive here is a harmless no-op, and a false-negative just falls back to
 * the resident daemon's ≤60s sweep.
 * @param {{state?:string, mergedAt?:string|null, labels?:Array, statusCheckRollup?:Array, reviewDecision?:string}|null} pr
 * @returns {boolean}
 */
export function isReadyToLand(pr, { requiredCheck = 'test' } = {}) {
  if (!pr || typeof pr !== 'object') return false;
  const state = String(pr.state || '').toUpperCase();
  if (state === 'MERGED' || pr.mergedAt || state === 'CLOSED') return false;
  const labels = labelNames(pr.labels);
  if (labels.some((l) => PARK_LABELS.includes(l))) return false;
  if (!isRequiredCheckGreen(pr, requiredCheck)) return false;
  if (!isReviewSignedOff(pr)) return false;
  return true;
}

/** Map a pure verdict to its exit code. `'pending'` has no exit code (the loop keeps going) → null. */
export function exitCodeForVerdict(verdict) {
  if (verdict === 'merged') return EXIT_MERGED;
  if (verdict === 'parked') return EXIT_PARKED;
  if (verdict === 'closed') return EXIT_CLOSED;
  return null;
}

// ── IO SHELL (runs only as a CLI — owns gh / the interval sleep / the wall-clock deadline / the exit) ─────────

/**
 * The watch loop: poll → classify → exit-on-terminal → sleep → repeat, until the deadline. The gh poll and the
 * sleep are INJECTED (`pollOnce`, `sleep`, `now`) so the loop is drivable in isolation and the poller can later
 * be swapped for the #2605 daemon watch (see the file-header UPGRADE SEAM) without touching this control flow.
 *
 * @param {{
 *   pollOnce: () => Promise<object|null>,     // one `gh pr view` read → parsed PR object (or null on a gh hiccup)
 *   sleep: (ms:number) => Promise<void>,      // interval wait
 *   now: () => number,                         // clock (epoch ms) — injected for determinism
 *   intervalMs: number, deadlineMs: number,   // poll cadence + wall-clock budget
 *   fireFastDrain?: (pr:object) => Promise<void>, // #2683 — fire the single-PR fast drain (best-effort; injected)
 *   requiredCheck?: string,                    // #2683 — the CI check the ready-to-land trigger waits on (default 'test')
 *   log?: (m:string) => void,                  // stderr progress line (optional)
 * }} io
 * @returns {Promise<number>} the resolved EXIT_* code (merged / parked / timeout).
 */
export async function watchPr({ pollOnce, sleep, now, intervalMs, deadlineMs, fireFastDrain = null, requiredCheck = 'test', log = () => {} }) {
  const start = now();
  // #2683 — the fast-drain trigger fires on the false→true transition of `isReadyToLand`, so it fires exactly
  // ONCE per ready-transition — on whichever landing precondition (CI-green / review-sign-off) completes LAST.
  // `wasReady` remembers the prior poll's readiness so a still-ready-but-not-yet-merged PR does not re-fire every
  // interval (no busy-drain); a PR that goes ready→not-ready (e.g. the fast drain rebase-drops it and CI
  // restarts) and later ready again correctly re-fires. EDGE (documented, not a bug): if the fast drain DEFERS
  // this target because a `blockedBy` sibling is still open (AC1 ordering), the fire is a no-op and `wasReady`
  // stays true — the target does not re-fire when the blocker later lands, so it falls back to the resident
  // daemon's ≤60s sweep for that one ordering-sensitive case (the daemon backstop, by design).
  let wasReady = false;
  for (;;) {
    // ── UPGRADE SEAM (#2605): this single `pollOnce()` is the ONLY gh touch in the loop. Swap it for a blocking
    //    `drain-daemon/cli.mjs watch --pr N` call (same parsed-PR return) and the classify/exit contract below
    //    is unchanged — the daemon push replaces the poll+sleep, nothing else. ─────────────────────────────────
    let pr = null;
    try {
      pr = await pollOnce();
    } catch (e) {
      // A transient gh failure must NOT kill the watch — log and let the deadline (below) bound it.
      log(`  ⚠ gh poll failed (retrying): ${String(e?.message || e).split('\n')[0]}`);
    }
    const verdict = classifyPr(pr);
    const code = exitCodeForVerdict(verdict);
    if (code !== null) {
      log(`  ● PR ${verdict} → exit ${code}`);
      return code;
    }
    // #2683 — EVENT-DRIVEN LAND. The PR is still `pending` (open, not parked). If it just reached the ready-to-land
    // state (the LAST precondition completed this poll), fire the single-PR fast drain NOW instead of waiting for
    // the resident daemon's next ≤60s sweep. Best-effort: a fire failure is logged and never kills the watch — the
    // daemon sweep is the backstop, and the fast drain re-derives the full gate server-side so an early/spurious
    // fire is a safe no-op (#2683 AC2). The subsequent poll observes the merge and exits `merged`.
    if (fireFastDrain) {
      const readyNow = isReadyToLand(pr, { requiredCheck });
      if (readyNow && !wasReady) {
        log(`  ⚡ PR ready to land (CI green + review signed off) → firing fast drain (#2683)`);
        try { await fireFastDrain(pr); } catch (e) { log(`  ⚠ fast-drain fire failed (harmless — the resident daemon sweep is the backstop): ${String(e?.message || e).split('\n')[0]}`); }
      }
      wasReady = readyNow;
    }
    if (now() - start >= deadlineMs) {
      log(`  ⏱ deadline reached while still pending → exit ${EXIT_TIMEOUT}`);
      return EXIT_TIMEOUT;
    }
    await sleep(intervalMs);
  }
}

/**
 * #2667 — on MERGE, auto-release the item's lane lease in EVERY pool it acquired. Delegates to the pool's own
 * cross-pool release-by-session (`lane-pool.mjs release --all-pools --session=<slug>`): the lease markers carry
 * the owning session (stamped at acquire/dispatch time), so a by-session sweep clears a cross-locus couple's WE
 * lane AND plateau-app lane in one call — no separate `(pool, lane)` ledger needed (the markers ARE that record).
 * BEST-EFFORT: a release failure is logged and NEVER changes the merge exit code (the merge is the truth; the
 * lease cleanup is secondary, and the periodic lease-reaper is the backstop for anything this misses).
 */
function releaseSessionAcrossPools(execFileSync, session, log) {
  const lanePoolCli = new URL('../lane-pool.mjs', import.meta.url);
  try {
    // #x5n4zn3 — was bare (no timeout): a real `lane-pool.mjs release` call.
    const out = execFileSync('node', [fileURLToPath(lanePoolCli), 'release', '--all-pools', `--session=${session}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: resolveChildTimeoutMs(),
      killSignal: 'SIGKILL',
    });
    log(`  ● auto-released lease(s) for session "${session}" across pools on merge`);
    if (out && out.trim()) log(out.trim());
  } catch (e) {
    log(`  ⚠ auto-release for session "${session}" failed (harmless — the lease-reaper is the backstop): ${String(e?.message || e).split('\n')[0]}`);
  }
}

/** First line of an error's message — the terse form used across the best-effort on-land passes. */
const firstLine = (e) => String(e?.message || e).split('\n')[0];

/** The repo root + on-land CLI paths, module-relative (so the pass works whatever the conveyor's cwd is).
 *  Factored out as a default-param provider so the unit test can inject dummy paths and never trigger this. */
function defaultOnLandPaths() {
  return {
    weRoot: fileURLToPath(new URL('../../', import.meta.url)), // scripts/conveyor/ → repo root
    backlogCli: fileURLToPath(new URL('../backlog.mjs', import.meta.url)),
    pushCli: fileURLToPath(new URL('../push-if-green.mjs', import.meta.url)),
  };
}

/**
 * #2752 — the conveyor's `--release-session` slug is `conveyor-<ref>`, where `<ref>` is the delivered item's
 * NNN (or a provisional `xNNNNNN` hash the drain JIT-numbers at land). Pull that ref out so the on-land
 * epic-resolve pass can ride the EXISTING `--release-session` wire with NO conveyor-skill change — the moment
 * this lands, every `pr-watch <pr> --release-session=conveyor-<num>` the conveyor already spawns also
 * mechanizes epic-resolve-on-last-child. A non-conveyor slug (or none) yields null; then the pass runs only
 * if an explicit `--resolve-epic-of=<ref>` was passed. Pure — exported for the unit test.
 * @param {string|undefined} slug
 * @returns {string|null}
 */
export function deriveChildRefFromSession(slug) {
  const m = typeof slug === 'string' ? slug.match(/^conveyor-(\d+|x[0-9a-z]+)$/i) : null;
  return m ? m[1] : null;
}

/**
 * #2752 — on MERGE, mechanize EPIC-RESOLVE-ON-LAST-CHILD: when the child story this PR delivered was its
 * parent epic's LAST open child, resolve the umbrella in the on-land cleanup — no session. This is the
 * epic-level sibling of the #2667/#2700 lease-release pass ({@link releaseSessionAcrossPools}) above: the same
 * drain-side on-land cleanup home the card names, wired to the same `--release-session` merge event. Steps —
 * ALL best-effort, a failure NEVER changes the merge exit code (the merge is the truth; the operator
 * `/resolve` is the backstop for anything this misses):
 *   1. `git pull --ff-only` — sync local main to the just-merged origin/main so the child's landed resolve AND
 *      its siblings' current statuses are visible to `resolve-parent`'s `parent:`-edge enumeration. Checking
 *      against FRESH main (not the child's stale lane, which can't see its siblings) is the whole reason this
 *      runs on-land. If the ff-only pull FAILS (a dirty/diverged primary tree) the pass ABORTS — writing on an
 *      un-synced `main` risks a resolve commit that can't ff-publish and strands a diverging commit; skipping
 *      is always safe (the operator `/resolve` is the backstop).
 *   2. `backlog.mjs resolve-parent <childRef> --json` — the pure verdict + (on a clean all-children-resolved
 *      close) the frontmatter splice, reusing the #658 no-open-slice enumeration. EDIT-ONLY: it never commits.
 *   3. On `resolved`: commit the epic card via an EXPLICIT pathspec (never `git add -A` — mirrors the drain's
 *      finalizeLand, so a concurrent session's staged hunks are never swept in) and publish via the SANCTIONED
 *      gated `push-if-green.mjs --assume-green` (#2172 transport — never a raw `main` push; main's CI already
 *      gated the couple). On `escalate`: log a one-line operator notice — a blocked/untriaged tail must NOT
 *      auto-close. On `skip`: nothing (the common "not the last child").
 * @param {typeof import('node:child_process').execFileSync} execFileSync  injected so the unit test drives it with no git
 * @param {string} childRef  the delivered child item's ref (NNN, or a provisional hash resolve-parent maps)
 * @param {(m:string)=>void} log
 * @param {{weRoot:string, backlogCli:string, pushCli:string}} [paths]  the repo root + CLI paths; defaults are
 *   derived from this module's URL (module-relative, so it works whatever the conveyor's cwd) — injected only
 *   in the unit test, so it never evaluates `fileURLToPath(import.meta.url)` under the test module transform.
 */
export function resolveEpicOnLand(execFileSync, childRef, log, paths = defaultOnLandPaths()) {
  const { weRoot, backlogCli, pushCli } = paths;
  // #x5n4zn3 — was bare (no timeout). This runs git/node commands against the SHARED primary checkout
  // (commit + gated publish of an epic-resolve splice on the last child's land) — generous, but bounded, so a
  // hung step here fails this one on-land pass rather than the whole drain.
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: weRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs() * 4, killSignal: 'SIGKILL' });
  // 1. sync local main. If the ff-only pull FAILS (a dirty/diverged primary tree), ABORT the whole pass — do
  //    NOT proceed. Acting on an un-synced tree risks writing a resolve commit on a `main` that is BEHIND
  //    origin, which then can't ff-publish and strands a diverging commit on the shared checkout. Skipping is
  //    always safe: the epic just isn't closed this land, and the next clean land / the operator `/resolve`
  //    is the backstop. (Stricter than the drain's own best-effort syncMain — this pass has no land to unwind
  //    if it bails, so it bails rather than risk the primary tree.)
  try { run('git', ['pull', '--ff-only']); }
  catch (e) { log(`  ⚠ epic-resolve: main sync failed — skipping (a dirty/diverged tree; the operator /resolve is the backstop): ${firstLine(e)}`); return; }
  // 2. the verdict + splice.
  let verdict = null;
  try { verdict = JSON.parse(String(run('node', [backlogCli, 'resolve-parent', String(childRef), '--json'])).trim()); }
  catch (e) { log(`  ⚠ epic-resolve: resolve-parent failed (harmless — the operator /resolve is the backstop): ${firstLine(e)}`); return; }
  if (!verdict || verdict.ok === false) { log(`  ⚠ epic-resolve: ${verdict && verdict.error ? verdict.error : 'no verdict returned'}`); return; }
  if (verdict.action === 'escalate') { log(`  ⚠ epic ${verdict.epic}: last child ${verdict.child} landed but it carries a judgment marker (${verdict.reason}) — needs a human /resolve, NOT auto-closed (#2752)`); return; }
  if (verdict.action !== 'resolved') { log(`  ● epic-resolve: nothing to do (${verdict.reason})`); return; }
  // 3. commit the epic card (explicit pathspec) + publish via the gated transport.
  try {
    run('git', ['add', '--', verdict.file]);
    run('git', ['commit', '-m', `drain: resolve epic ${verdict.epic} on last-child ${verdict.child} land (#2752)`, '--', verdict.file]);
  } catch (e) { log(`  ⚠ epic-resolve: commit of ${verdict.file} failed: ${firstLine(e)}`); return; }
  try { run('node', [pushCli, '--assume-green', '--json']); log(`  ● resolved epic ${verdict.epic} on last-child land + published (#2752)`); }
  catch (e) { log(`  ⚠ epic-resolve: publish failed (the commit is local — a re-drain / the operator publishes it): ${firstLine(e)}`); }
}

async function main(argv) {
  const { execFileSync } = await import('node:child_process');

  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  const log = (m) => process.stderr.write(m + '\n');

  const prNumber = positionals[0] ?? flags.pr;
  if (prNumber == null || !/^\d+$/.test(String(prNumber))) {
    log('usage: pr-watch.mjs <pr-number> [--interval=20] [--timeout-min=30] [--repo=owner/name] [--check=test] [--no-fast-drain] [--release-session=<slug>] [--resolve-epic-of=<childRef>] [--no-resolve-epic] [--json]');
    process.exit(EXIT_ERROR);
  }

  const intervalMs = Math.max(1, Number(flags.interval) || 20) * 1000; // default 20s poll cadence
  const deadlineMs = Math.max(1, Number(flags['timeout-min']) || 30) * 60_000; // default 30min wall-clock budget
  const requiredCheck = typeof flags.check === 'string' && flags.check ? flags.check : 'test';

  // ONE gh poll → the parsed PR object (or null on any gh failure, so watchPr's retry-until-deadline applies).
  // #2683 — also fetch `statusCheckRollup` + `reviewDecision` so the ready-to-land trigger can see BOTH landing
  // preconditions (CI-green and the non-author review sign-off) and fire on whichever completes last.
  const pollOnce = async () => {
    const args = ['pr', 'view', String(prNumber), '--json', 'state,mergedAt,labels,statusCheckRollup,reviewDecision'];
    if (typeof flags.repo === 'string') args.push('--repo', flags.repo);
    // #x5n4zn3 — was bare (no timeout).
    const out = readGh(args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
    return JSON.parse(out);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // #2683 — the EVENT-DRIVEN LAND trigger. On the ready-to-land transition, shell the daemon's OWN land path
  // scoped to one PR (`merge-ai-prs.mjs --only=<pr> --label=ready-to-merge`) so the queued PR lands the instant
  // it is ready instead of waiting for the resident daemon's next ≤60s sweep. It carries the daemon's full
  // ordering (blockedBy/impl-first via `--only`'s cross-repo context), authority (server-side re-gate), and
  // mutual-exclusion (the serial-writer mutex + per-PR idempotency guard) — never a caller-trusted shortcut.
  // `--only-repo` disambiguates a sibling-repo PR; omitted for the common local-repo PR. Disable with
  // `--no-fast-drain` (falls back to the pure daemon-sweep cadence). Best-effort — a fire error never fails the
  // watch (watchPr catches it); the drain runs one-shot and returns quickly (it is NOT `--watch`).
  const mergeCli = fileURLToPath(new URL('../merge-ai-prs.mjs', import.meta.url));
  const fireFastDrain = flags['no-fast-drain'] ? null : async () => {
    const args = [mergeCli, `--only=${prNumber}`, '--label=ready-to-merge'];
    if (typeof flags.repo === 'string') args.push(`--only-repo=${flags.repo}`);
    // #x5n4zn3 — was bare (no timeout).
    execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  };

  log(`watching PR #${prNumber} (poll ${intervalMs / 1000}s · deadline ${deadlineMs / 60_000}min${fireFastDrain ? ' · event-driven land ON' : ''}) …`);
  const code = await watchPr({ pollOnce, sleep, now: Date.now, intervalMs, deadlineMs, fireFastDrain, requiredCheck, log });

  // #2667 — on MERGE, auto-release the item's lane lease in every pool it acquired (opt-in via
  // --release-session=<slug>). A non-merge exit (parked / closed / timeout) never releases — a still-open lane
  // is still in use. Runs BEFORE the JSON emit + exit so the release completes while this process is alive.
  if (code === EXIT_MERGED && typeof flags['release-session'] === 'string' && flags['release-session']) {
    releaseSessionAcrossPools(execFileSync, flags['release-session'], log);
  }

  // #2752 — on MERGE, mechanize epic-resolve-on-last-child (the epic-level sibling of the lease-release
  // above). The delivered child item's ref comes from --resolve-epic-of=<ref>, else is derived from the
  // conveyor's --release-session=conveyor-<ref> slug (so it rides the EXISTING conveyor wire with no skill
  // change). Disable with --no-resolve-epic. Only on a MERGE exit — a park/close/timeout means the child
  // never landed, so there is no last-child close to make. Best-effort: never changes the exit code.
  if (code === EXIT_MERGED && !flags['no-resolve-epic']) {
    const childRef = (typeof flags['resolve-epic-of'] === 'string' && flags['resolve-epic-of'])
      ? flags['resolve-epic-of']
      : deriveChildRefFromSession(flags['release-session']);
    if (childRef) resolveEpicOnLand(execFileSync, childRef, log);
  }

  if (flags.json) {
    const outcome =
      code === EXIT_MERGED ? 'merged'
      : code === EXIT_PARKED ? 'parked'
      : code === EXIT_CLOSED ? 'closed'
      : 'timeout';
    writeAllSync(1, JSON.stringify({ pr: Number(prNumber), outcome, exit: code }, null, 2) + '\n');
  }
  process.exit(code);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writeAllSync } from '../lib/write-all-sync.mjs';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
