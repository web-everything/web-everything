/**
 * lane-verify.mjs — the pure verification-record core for #2833 (subagent-stall mitigation).
 *
 * THE STALL THIS EXISTS FOR. A build subagent's delivery arc is: run the required suites, then
 * `lane-pool release` / `pr-land` to finish. Twice one night a subagent BACKGROUNDED its long test run and
 * then yielded/terminated before the run finished — leaving the lane/PR mid-flight, producing nothing, never
 * erroring, so nothing reclaimed it. The root cause (prevention-introspection): the verification was
 * BACKGROUNDABLE, and yielding mid-run LOOKED complete. The fix must make an unfinished verification NOT look
 * complete.
 *
 * THE MECHANISM. A lane records its verification as a marker keyed to the exact commit it verified:
 *   - `scripts/verify-lane.mjs` runs the suites SYNCHRONOUSLY (foreground, blocks until exit). It writes a
 *     `running` marker at start and rewrites it to `green`/`red` at finish. If the process is killed mid-run
 *     (the stall), the marker is stranded at `running` — a DETECTABLY-unfinished verification.
 *   - the delivery gate (`pr-land.mjs`) reads the marker for the HEAD it is about to land and REFUSES when the
 *     verification is unfinished (`running` — the exact stall signature) or — since #3321, BY DEFAULT — absent
 *     or red. A stranded/abandoned run can no longer masquerade as a delivered lane, and neither can a lane that
 *     never started one.
 *
 * This module is the DECISION half — the gate functions (`verifyGateDecision`, `isVerifyAbandoned`, the marker
 * body builders) take no filesystem, no git, no clock (the caller passes `nowMs`), so they stay unit-testable.
 * `verify-lane.mjs` owns the heavy IO (git rev-parse, the synchronous suite run) and `pr-land.mjs` calls
 * `verifyGateDecision` at its finish-guard. Mirrors the split in `scripts/lib/lane-lease.mjs`.
 *
 * The ONE piece of IO that lives here is the SHARED marker reader (`readVerifyMarker` / its pure normalizer
 * `normalizeVerifyRecord`): both entry points (`verify-lane.mjs`'s `readMarker` and `pr-land.mjs`'s finish-guard)
 * read the exact same marker, and #2833 finding 2 was that they hand-inlined two *different* parsers — pr-land's
 * caught only a throw, so a valid-JSON non-object (`null`/`"x"`/`[]`) slipped through as "no sha → untracked →
 * land unverified". Single-sourcing the read here is the fix (a valid-JSON non-object normalizes to
 * `{ corrupt: true }`, which the gate refuses). Likewise `resolveVerifyOptions` single-sources the
 * `--require-verified`/`WE_REQUIRE_VERIFIED`/`WE_LAND_UNVERIFIED` flag+env resolution both entry points apply
 * (#2833 finding 5 — `check` mode used to ignore `WE_REQUIRE_VERIFIED`, disagreeing with pr-land).
 *
 * ── #3321: VERIFICATION IS MANDATORY BEFORE A LANE LANDS ────────────────────────────────────────────────
 * #2833 shipped the gate but left `requireVerified` DEFAULT FALSE, so the mandatory half never engaged: a lane
 * whose suites had never run at all landed on the `untracked` verdict — "no marker → not tracked here → allow".
 * That is a gate that PASSES WHEN IT CANNOT TELL, and it is measurably expensive: 18 of the 39 confirmed review
 * findings in `scripts/review-corpus/` had their input available at COMMIT time, where the very suite this marker
 * records would have caught them. The suite itself had been red on every macOS host and nobody noticed, because
 * nothing on the delivery path was obliged to look.
 *
 * So the default INVERTS. Verification is required unless a caller explicitly says otherwise, and there are now
 * exactly two documented ways past the gate — deliberately different in strength:
 *
 *   1. OPT-OUT — `--no-require-verified` (or `--require-verified=0|false|no|off`, or `WE_REQUIRE_VERIFIED=0`).
 *      Restores the pre-#3321 ADVISORY posture for callers that genuinely verify elsewhere. An opt-out with no
 *      callers would be a claim, not an escape hatch. The callers that TAKE it are two files:
 *        · `we:scripts/lane-drain.mjs#buildPrLandArgs` — the merge-queue drain. Lands from the PRIMARY checkout,
 *          where a lane clone's marker cannot exist; its required GitHub check is the real gate (#1937).
 *        · `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` — all FOUR invocations (the WE and
 *          impl per-lane PR opens, and the two Finalize label-reconcile calls, the latter from PRIMARY_ROOT
 *          against a lane ref — the same unreachable-marker shape as the drain). That workflow already runs the
 *          full gate at its step 4; it verifies without RECORDING, and its file says why it cannot simply record.
 *      Both are the SAME shape: the marker is structurally unreachable, so demanding it could only ever fail.
 *
 *      RETRACTION — THIS LIST WAS TWICE DESCRIBED AS SOMETHING IT IS NOT. Round 2 of PR #1609 called it "exactly
 *      one" entry, on the strength of a caller sweep that had missed the workflow. Round 3 corrected the count and
 *      then made a second, larger false claim, which read:
 *
 *          "THE COMPLETE LIST, swept from every repo-committed `pr-land.mjs` invocation carrying a
 *           `--ref=`/`--repo=`, and it is two files, not one … The sweep now RUNS … it harvests every committed
 *           `pr-land` invocation straight from source … A new flag-free call site reddens the suite instead of
 *           reaching the gate — so this comment can now only go stale, never silently wrong."
 *
 *      WRONG, AND WRONG AT THE TIME. The round-3 sweep iterated two hard-coded filenames, so a flag-free call
 *      site in a THIRD file reached the gate in silence (review round 3 measured exactly that: the suite stayed
 *      green at 53 passed with one added to `we:scripts/lane-review.mjs`). And "every repo-committed invocation"
 *      was false by the sweep's own predicate — run over `git ls-files` it found three further emitters saying
 *      nothing about verification. What is written above is therefore NOT a completeness claim about `pr-land`
 *      call sites; it is the list of callers that take THIS ESCAPE.
 *
 *      RETRACTION, ROUND 5 — the sentence that used to finish that paragraph read: "and it is the sweep, not
 *      this comment, that is now authoritative about the rest." FALSE WHEN WRITTEN, and false by the sweep's own
 *      predicate for the fourth consecutive round. Round 4's sweep matched only the bare spelling
 *      `node scripts/pr-land.mjs …`, while this repo's documentation convention writes `node we:scripts/…`, so
 *      one live emitter was invisible to it: `we:agent-memory-src/lane-pr-is-universal-delivery-all-repos.md` —
 *      a `type: feedback` agent memory, i.e. a loaded instruction, carrying the canonical cross-repo delivery arc
 *      for Frontier UI and plateau-app, flag-free and with no adjacent verify. An agent following it would have
 *      met this gate at `pr-land` step 1b with exit 3 / `unverified`. Measured, not assumed: running the sweep's
 *      own predicate over `git grep -lF pr-land.mjs` (213 candidate files) with and without an optional `we:`
 *      prefix harvested 8 invocations vs 7, and that file's line was the whole difference.
 *
 *      THE SWEEP IS WHAT HOLDS — WITHIN ITS STATED SCOPE, WHICH IS NOT "EVERYTHING".
 *      `we:scripts/__tests__/lane-verify.test.mjs` ("caller sweep") harvests every `pr-land` COMMAND STRING it
 *      can see from `git grep -lF pr-land.mjs` over tracked files — minus one stated, count-pinned exclusion
 *      (`pr-land.mjs`'s own `--help` banner) — and requires each to DECLARE ITS POSTURE: carry a verify flag, or
 *      be preceded within 3 lines by a `verify-lane.mjs` / `run.mjs verify` run. Each is then driven through this
 *      resolver and `verifyGateDecision` on the marker state that path really sees. Its LIMITS are stated there
 *      rather than left for the next round to discover: it reads command strings carrying at least one `--flag`
 *      (a bare flagless `node …pr-land.mjs` in prose is not harvested), it knows three spellings of the path
 *      (bare, `we:`, `./`), array-built argvs are pinned by a separate case, and source adjacency is a proxy for
 *      "the verify precedes the land", never a proof of execution order. Two named MUTATION PROBES — the plain
 *      shape and the `we:`-prefixed shape, each injected into a real tracked file — pin that a flag-free call
 *      site in a file nobody listed reddens the suite.
 *
 *      THE OTHER ARM IS THE POINT OF THE ITEM. The lane-local emitters (the serial `/batch` close-out in
 *      `we:skills-src/batch-backlog-items/SKILL.md`, the canonical per-item arc in
 *      `we:docs/agent/backlog-workflow.md`, `we:agent-memory-src/single-session-should-use-a-lane.md`, and — added
 *      in round 5 — the cross-repo arc in `we:agent-memory-src/lane-pr-is-universal-delivery-all-repos.md`) do NOT
 *      take this opt-out and must not: they run `pr-land` from the LANE, where the marker IS reachable, so the
 *      strict gate is the correct answer and a blanket opt-out would gut the gate on the one path where it can
 *      engage. They were nevertheless BROKEN, in two different ways. `we:docs/agent/backlog-workflow.md` ran the
 *      `verify` operation BEFORE `resolve` and before the item commit, so the sha-keyed marker it wrote was
 *      already STALE at land (the #3212 shape; measured `ok:false` / `unverified` on a stale green, same as on an
 *      absent one). The other three named no marker-writing verification at all — `/batch`'s SKILL.md ran the
 *      item's in-locus gate directly (`npm run check:standards --scope=…`, which writes no marker), and neither
 *      agent memory mentioned verification. Each now records the verification AFTER the item commit, immediately
 *      before `pr-land`.
 *
 *      WHAT THAT COSTS, STATED HONESTLY. An earlier cut of this paragraph, and of the card, called it "one suite
 *      run per item, relocated — not a second one". WRONG. Measured against `origin/main`'s copies: the earlier
 *      check in `backlog-workflow.md` and `/batch`'s in-locus gate are both still instructed, so for those two
 *      arcs this is an ADDITIONAL run of `verify-lane`'s gate, not a moved one; and for the two agent memories
 *      there was no verification before at all, so it is a FIRST.
 *
 *      The opt-out relaxes only the two "we never saw a result" cells —
 *      absent/stale and `red` — and it is NOT a bypass: a FRESH `running` marker (the #2833 stall) and a
 *      `corrupt` marker still refuse, because those are evidence of a BROKEN verification, not a missing one.
 *   2. BREAK-GLASS — `WE_LAND_UNVERIFIED=1`. The full override, every cell, including stall and corrupt. For a
 *      guard bug or a wedged lane; the PR still rides the required CI check. House style: `WE_MERGE_BREAK_GLASS`.
 *
 * Fail-closed by construction: `verifyGateDecision`'s own `requireVerified` parameter defaults TRUE as well, so a
 * caller that FORGETS to pass the resolved option gets the strict gate, never the permissive one. The whole
 * defect class this item closes is a default that reads as "allow" when the answer is unknown.
 */
import { describeTimeoutRetry } from './gate-timeout-retry.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { constants } from 'node:os';
import { boundFailureDetails } from './verify-failures.mjs';

/** The marker lives in the lane clone's `.git/` (like `.lane-lease`): never tracked, never `git clean`-ed,
 *  invisible to `git status`, one-per-lane. */
export const VERIFY_FILENAME = '.lane-verify';

/** #3751 — where a superseded terminal record for an earlier commit of the same lane is kept. */
export const VERIFY_PREVIOUS_FILENAME = '.lane-verify.previous';

/** Normalize a JSON-parsed marker payload to the shape the gate expects. Pure. A parsed value that is not a
 *  plain object (an array, `null`, a string, a number — all VALID JSON) is NOT a verification record: fold it to
 *  `{ corrupt: true }` so the gate refuses it, never treats it as `absent` and fails OPEN (#2833 finding 2/5). A
 *  plain object passes through untouched (its fields are validated downstream by `verifyGateDecision`). */
export function normalizeVerifyRecord(parsed) {
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { corrupt: true };
}

/** Read + normalize the lane verification marker from a git dir. The SINGLE reader both entry points share
 *  (#2833 finding 2): resolve `<gitDir>/.lane-verify`, and
 *    - missing file            → `null`   (absent — the gate decides per `requireVerified`),
 *    - present but unparseable  → `{ corrupt: true }` (torn/garbled — the gate refuses, never fails open),
 *    - present valid non-object → `{ corrupt: true }` (via `normalizeVerifyRecord` — the finding-2 hole),
 *    - present plain object     → the record as-is.
 *  IO (fs read) — but the whole point is that the read is defined in exactly one place so the two callers can
 *  never drift. `gitDir` is the ABSOLUTE git dir (`git rev-parse --absolute-git-dir`), correct for both a clone
 *  (`.git` is a directory) and a worktree (`.git` is a file / relocated). */
export function readVerifyMarker(gitDir) {
  const markerPath = join(gitDir, VERIFY_FILENAME);
  if (!existsSync(markerPath)) return null;
  try {
    return normalizeVerifyRecord(JSON.parse(readFileSync(markerPath, 'utf8')));
  } catch {
    return { corrupt: true };
  }
}

/**
 * Should a lane RESET keep the verify marker it finds? Pure. Only a record for the very commit the reset lands on
 * survives; anything else belongs to the previous holder's tree (#3383, 2026-09-23: a freshly acquired lane kept
 * a stranger's terminal green for another sha, and `verify-lane.mjs` refused to START (`superseded`) until someone
 * ran `reset` by hand). A corrupt marker never survives.
 * @param {object|null} record {@link readVerifyMarker} output
 * @param {string} headSha the commit the reset left HEAD on
 */
export function keepMarkerAfterReset(record, headSha) {
  if (!record || record.corrupt) return false;
  return typeof record.sha === 'string' && record.sha === headSha;
}

/** The tokens that mean "no" in a flag value or an env var. `''` is deliberately NOT one of them: an env var set
 *  to empty is an accident, not a decision, and a fail-closed gate must not read an accident as consent (#3321). */
const NEGATIVE_TOKENS = new Set(['0', 'false', 'no', 'off']);

/** Is this flag/env value an EXPLICIT negative? Pure. `undefined` (absent) is not — absence never opts out. */
function isNegative(value) {
  if (value === false) return true;
  return typeof value === 'string' && NEGATIVE_TOKENS.has(value.trim().toLowerCase());
}

/** Resolve the verification GATE options from an entry point's parsed flags + process env. Pure. The SINGLE
 *  source both `verify-lane.mjs check` and `pr-land.mjs` call, so the two can never disagree (#2833 finding 5 —
 *  `check` mode read only `flags['require-verified']` while pr-land also honoured `WE_REQUIRE_VERIFIED`, so the
 *  same environment gave two verdicts).
 *
 *  #3321 — `requireVerified` now defaults TRUE. Verification is MANDATORY before a lane lands; a caller must say
 *  so explicitly to land unverified, and saying nothing means "verified, please", never "don't bother":
 *    - `--require-verified` (bare, or `=1|true|…`)  → required  (the pre-#3321 spelling, still honoured)
 *    - `WE_REQUIRE_VERIFIED=1`                      → required  (ditto)
 *    - nothing at all                               → required  ← THE FLIP
 *    - `--no-require-verified`                      → OPT-OUT   (advisory posture; NOT a bypass — see below)
 *    - `--require-verified=0|false|no|off`          → OPT-OUT
 *    - `WE_REQUIRE_VERIFIED=0|false|no|off`         → OPT-OUT
 *  The opt-out only relaxes the "we never saw a result" cells (absent/stale, `red`). A fresh `running` marker
 *  (the #2833 stall) and a `corrupt` marker still refuse under it — the FULL override is `WE_LAND_UNVERIFIED=1`,
 *  reported separately as `breakGlass`. Two different strengths, kept distinguishable on purpose.
 *
 *  When those inputs CONFLICT, an explicit positive FLAG beats a negative ENV (`--require-verified` with an
 *  ambient `WE_REQUIRE_VERIFIED=0` ⇒ required), and `--require-verified` beats `--no-require-verified`. Both
 *  tie-breaks resolve toward verifying — a fail-closed gate must not read a contradiction as consent, for the
 *  same reason an empty env var is not consent. See the precedence note in the body. */
export function resolveVerifyOptions({ flags = {}, env = {} } = {}) {
  // PRECEDENCE: an EXPLICIT POSITIVE FLAG OUTRANKS EVERYTHING BELOW IT — including a negative env var. The first
  // cut of #3321 collapsed flag and env into one flat OR, which silently regressed the pre-#3321 precedence: an
  // ambient `WE_REQUIRE_VERIFIED=0` in the environment defeated an explicit `--require-verified` on the command
  // line (the old resolver had the flag win, since it was `!!flag || env === '1'`). That is fail-OPEN on a
  // contradictory invocation, and this gate exists to fail CLOSED. A flag is a decision made HERE, for THIS run;
  // an env var is ambient and may be inherited from a parent process that knew nothing about this call. When they
  // disagree, the deliberate one wins — and when the deliberate one is "verify", it wins doubly, because reading a
  // stale export as permission to skip verification is the whole defect class this item closes.
  const flagRequires = flags['require-verified'] !== undefined && !isNegative(flags['require-verified']);
  const optedOut = !flagRequires && (
    // `--no-require-verified` — present and not itself negated (`--no-require-verified=0` is a double negative
    // nobody means; treat only a straightforward presence as the opt-out). Passing BOTH `--require-verified` and
    // `--no-require-verified` is contradictory, and `flagRequires` above resolves it fail-closed: verify.
    (flags['no-require-verified'] !== undefined && !isNegative(flags['no-require-verified']))
    || isNegative(flags['require-verified'])
    || isNegative(env.WE_REQUIRE_VERIFIED));
  return {
    requireVerified: !optedOut,
    breakGlass: env.WE_LAND_UNVERIFIED === '1',
  };
}

/** How long a `running` marker may sit before it reads as ABANDONED rather than still-in-flight. This only
 *  refines the human message (`abandoned` vs `in-flight`) — a `running` marker is "verification unfinished"
 *  either way, so the gate refuses regardless of age. Long enough to outlast a genuinely slow suite. */
export const DEFAULT_VERIFY_TTL_MINUTES = 30;

/** Build the AT-START (`running`) marker. The caller stamps `startedAt` (ISO) and the resolved `sha` so this
 *  stays clock-free / git-free / testable. `suites` is the gate command string, recorded for the message.
 *  `treeHash` (#4473, optional) is the working-tree content hash ({@link ../lib/verify-lane-gate.mjs}'s
 *  `computeWorkingTreeHash`) the IO shell computed BEFORE this call — carried through so a later `request`/
 *  `verify` can tell "the tree is byte-identical to what this record verified" apart from "same commit, tree
 *  moved since"; omitted/`null` (every existing caller) never enables that fast path. */
export function verifyStartBody({ sha, suites, startedAt, treeHash, runId }) {
  return {
    sha: sha || null,
    status: 'running',
    startedAt: startedAt || null,
    finishedAt: null,
    suites: suites || null,
    exitCode: null,
    treeHash: treeHash ?? null,
    // `runId` (optional) identifies the dispatcher run that stamped this marker, so the dispatcher can later tell
    // its own marker from a newer same-sha/suites/tree `request`. Omitted when absent — existing shapes unchanged.
    ...(runId ? { runId } : {}),
  };
}

/** Rewrite a `running` marker into its terminal (`green`/`red`) form once the synchronous run has exited.
 *  Pure: the caller supplies `finishedAt` (ISO), the process `exitCode` (0 ⇒ green), and — crucially — the
 *  `sha` this run ACTUALLY verified.
 *
 *  #2833 finding 1: the finish write must stamp the sha the run itself captured at START, NEVER inherit it from
 *  the on-disk marker (`prev.sha`). Two overlapping `verify-lane` runs share one clone's marker; if a slow run
 *  finishing at X copies whatever sha is on disk (a newer run's Y) onto its own green, it publishes a false
 *  green for a tree it never verified — the exact false-green this guard exists to kill. So `sha` is passed
 *  explicitly and wins. `prev` supplies only `startedAt`/`suites` (audit fields); `base.sha` is a fallback for
 *  legacy callers that pass their own start body as `prev`. */
/** Classify process termination without inventing an OOM/host-load diagnosis from a signal alone. */
export function verificationInfrastructureFailure({ exitCode, signal, timedOutPhase, ceilingMs } = {}) {
  const inferred = Number.isInteger(exitCode) && exitCode > 128
    ? Object.entries(constants.signals).find(([, n]) => n === exitCode - 128)?.[0] : null;
  const killedBy = signal || inferred;
  if (!timedOutPhase && !killedBy) return null;
  return {
    reason: timedOutPhase ? 'verify-timeout' : 'verify-signal',
    signal: killedBy || 'SIGKILL',
    ...(timedOutPhase ? { phase: timedOutPhase, ceilingMs } : {}),
    detail: timedOutPhase
      ? `verification infrastructure failure: dispatcher killed the process tree with SIGKILL after the ${ceilingMs}ms ${timedOutPhase}-phase ceiling; no test verdict. Inspect the verify-daemon log before explicitly retrying.`
      : `verification infrastructure failure: ${killedBy}${signal ? '' : ` (shell exit ${exitCode})`}; sender/cause unknown (not proof of OOM or a timeout); no test verdict. Inspect host and verify-daemon logs before explicitly retrying.`,
  };
}

export function verifyFinishBody(prev, { finishedAt, exitCode, sha, treeHash, suites, signal, infrastructure, failureDetails, retriedTimeouts } = {}) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const failure = infrastructure || verificationInfrastructureFailure({ exitCode, signal });
  const green = exitCode != null && Number(exitCode) === 0 && !failure;
  return {
    sha: sha ?? base.sha ?? null,
    status: failure ? 'infrastructure-failure' : green ? 'green' : 'red',
    ...(failure ? { infrastructure: failure } : {}),
    ...(retriedTimeouts?.length ? { retriedTimeouts } : {}),
    // A test verdict only: an infrastructure failure produced no verdict, so it carries no failing-test names.
    ...(!green && !failure && failureDetails ? { failureDetails: boundFailureDetails(failureDetails) } : {}),
    startedAt: base.startedAt ?? null,
    finishedAt: finishedAt || null,
    // #4473 — `suites` is part of the cache key too, so the gate THIS run executed wins (PR #2982 round-2 review):
    // an overlapping `request --gate=<other>` re-stamps the shared marker with ITS command, and inheriting that
    // would relabel this run's green as a green for a gate that never ran.
    suites: suites ?? base.suites ?? null,
    exitCode: exitCode != null && Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    // #4473 — the cache key. Like `sha`, an explicit `treeHash` (the hash the run itself captured) WINS over
    // `base.treeHash` (PR #2982 review): `base` is usually re-read off the shared on-disk marker, which an
    // overlapping `request` can have re-stamped with a NEWER, unverified tree's hash — inheriting it would publish
    // a cacheable green for that tree. `verify-lane.mjs` always passes it; `base.treeHash` is a legacy fallback.
    treeHash: treeHash !== undefined ? treeHash : (base.treeHash ?? null),
  };
}

/** Has a `running` marker outlived its TTL (⇒ ABANDONED — the writer is presumed gone)? A `green`/`red`
 *  marker never expires by time: its `sha` binds it to an exact tree, so SHA-identity — not the clock — is the
 *  real freshness test. A malformed / dateless `running` marker reads as abandoned (fail toward "not fresh").
 *  Pure — the caller passes `nowMs`. */
export function isVerifyAbandoned(record, nowMs, ttlMs = DEFAULT_VERIFY_TTL_MINUTES * 60_000) {
  if (!record || typeof record !== 'object') return true;
  if (record.status !== 'running') return false;
  const at = Date.parse(record.startedAt);
  if (Number.isNaN(at)) return true;
  return nowMs - at >= ttlMs;
}

/** How often `waitForVerifySettle` re-checks the marker inside one bounded wait (#4358). This is an INTERNAL
 *  poll cadence, not a per-turn one: the whole point of the wait is that a single call absorbs however many of
 *  these it takes, so a short interval costs nothing extra in the metric that actually mattered before this
 *  item (tool-call COUNT) — only the ceiling below needs to stay conservative. */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 2_000;

/** The most ONE wait may ever block: the default 120-minute admission budget, five-minute queue buffer,
 *  30-minute execution budget and five-minute dispatch margin. A dispatched agent's foreground tool call is
 *  killed at the Bash tool's own `timeout` (10 minutes), so the conveyor briefs never ask for the whole budget in
 *  one call — they chain `check --wait=540000` calls (each fits that window) up to this total; this constant is
 *  only the clamp for callers that genuinely can block that long. */
export const MAX_SAFE_WAIT_MS = 160 * 60_000;

/** Clamp a requested `--wait=<ms>` to {@link MAX_SAFE_WAIT_MS}. Pure, and pulled out of `verify-lane.mjs`
 *  specifically so the clamp itself — not just the stderr warning that mentions it — has a direct unit test. */
export function resolveWaitCeilingMs(requestedMs) {
  return Math.min(requestedMs, MAX_SAFE_WAIT_MS);
}

/**
 * Bounded, internally-pollable wait for the verify marker to SETTLE (#4358) — the core this item exists to add.
 * Pure except for the injected IO/clock/sleep, so it is unit-testable with a fake clock and fake marker reads,
 * no real timers and no real git. Poll until the FIRST result that is genuinely final:
 *
 *   - **`green`/`red`/`infrastructure-failure` end a wait as `settled`** (`result.settled === true`) — the terminal states a
 *     run produces at finish (settled does not imply passed).
 *   - **A HEAD move mid-wait** (the tracked sha stops being current — a new commit landed on the lane) is its
 *     own distinct case (`status: 'head-moved'`), never folded into "still pending": a marker keyed to a sha
 *     that is no longer HEAD can never settle for THIS wait, no matter how much longer it runs.
 *   - **`running` is the ONLY status this loop keeps POLLING on.** `scripts/conveyor/verify-dispatch.mjs`
 *     dispatches a lane precisely when its marker is `running` for this head, and only then — that is the one
 *     status a background process can still move off of. Every OTHER status this function can see
 *     (`break-glass`, `corrupt`, `absent`, `untracked`) ends the wait IMMEDIATELY instead, UNSETTLED
 *     (`settled: false`) — the same verdict the non-waiting `check` already gives for that status, just without
 *     burning the ceiling on a status more waiting cannot change: `break-glass` is a constant override, `corrupt`
 *     needs a human, and `absent`/`untracked` (no record recognized for this head) can only ever be fixed by an
 *     explicit `request`/`verify`/`reset` — never by waiting longer here. (Converge round 1, #4358 — both the
 *     panel and an independent red-team caught this: treating `absent` as "still pending" made a forgotten
 *     `request` cost a FULL ceiling before saying so, and every retry the brief tells the caller to make on a
 *     `timeout` would repeat that cost with no way to make progress.) None of these four is folded into "done"
 *     just because its own `ok` can be `true` (#4358 risk: never conflate `ok:true` with "settled").
 *   - **If `ceilingMs` elapses while still `running`**, the wait ends UNSETTLED as `status: 'timeout'` —
 *     `lastStatus`/`lastReason` carry the last real read for diagnosis, but never substitute for the honest
 *     `timeout` verdict itself.
 *
 * @param {object} opts
 * @param {() => (object|null)} opts.readRecord - reads the current marker fresh; called every poll
 * @param {() => (string|null)} opts.readHead - reads the CURRENT head sha fresh; called every poll (catches a move)
 * @param {string} opts.headSha - the sha this wait is tracking (captured once, before the wait started)
 * @param {boolean} [opts.breakGlass]
 * @param {boolean} [opts.requireVerified]
 * @param {number} opts.ceilingMs - the bounded wait ceiling (the caller clamps this to {@link MAX_SAFE_WAIT_MS})
 * @param {number} [opts.pollIntervalMs]
 * @param {() => number} [opts.now] - injectable clock (defaults to `Date.now`)
 * @param {(ms:number) => Promise<void>} [opts.sleep] - injectable delay (defaults to a real `setTimeout`)
 * @param {(record: object) => (string[]|null|undefined)} [opts.resolveLaneRelevantChangeSince] - #4296, called
 *   with the FULL record on every poll for which the caller supplied a callback (never just the record's sha —
 *   the callback is expected to wrap `laneRelevantChangeSinceForRecord`, which owns the actual
 *   corrupt/missing-sha/exact-match guard, including the cheap no-git-IO return for an exact match, so calling it
 *   unconditionally costs nothing in the common case) — the IO half `verifyGateDecision`'s `laneRelevantChangeSince`
 *   needs. Omitted entirely ⇒ every poll keeps the pre-#4296 exact-sha behavior (never promotes a stale-sha record
 *   to a match).
 * @returns {Promise<{sha:string, status:string, reason:string, ok:boolean, detail:string, settled:boolean, waited:{ms:number, polls:number}, lastStatus?:string, lastReason?:string}>}
 */
export async function waitForVerifySettle({
  readRecord,
  readHead,
  headSha,
  breakGlass = false,
  requireVerified = true,
  resolveLaneRelevantChangeSince,
  ceilingMs,
  pollIntervalMs = DEFAULT_WAIT_POLL_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const startedAt = now();
  let polls = 0;
  for (;;) {
    polls += 1;
    const currentHead = readHead();
    if (currentHead && currentHead !== headSha) {
      return {
        sha: headSha, status: 'head-moved', reason: 'head-moved', ok: false,
        detail: `HEAD moved from ${String(headSha).slice(0, 8)} to ${String(currentHead).slice(0, 8)} while waiting — a marker keyed to ${String(headSha).slice(0, 8)} can never settle for this wait now; re-run \`verify-lane.mjs request\` and \`check --wait=\` for the new HEAD.`,
        settled: false, waited: { ms: now() - startedAt, polls },
      };
    }

    const currentRecord = readRecord();
    // #4296 (converge round 2, simplicity juror) — call the resolver whenever the caller SUPPLIED one, full stop.
    // No local pre-check of "is there even a stale-sha record" here: that was a THIRD partial copy of the same
    // guard `laneRelevantChangeSinceForRecord` already owns, and the round-1 fix of the OTHER two copies still
    // left this one behind. The wrapper already returns `undefined` cheaply (no git IO) for a missing/corrupt
    // record or an exact match, so calling it unconditionally costs nothing in the common case.
    const laneRelevantChangeSince = resolveLaneRelevantChangeSince
      ? resolveLaneRelevantChangeSince(currentRecord)
      : undefined;
    const v = verifyGateDecision({ record: currentRecord, headSha, breakGlass, requireVerified, laneRelevantChangeSince });

    if (v.status === 'green' || v.status === 'red' || v.status === 'infrastructure-failure') {
      return { ...v, sha: headSha, settled: true, waited: { ms: now() - startedAt, polls } };
    }
    // Only `running` keeps polling — see the function doc above for why. Everything else ends NOW, unsettled.
    if (v.status !== 'running') {
      return { ...v, sha: headSha, settled: false, waited: { ms: now() - startedAt, polls } };
    }

    const elapsed = now() - startedAt;
    if (elapsed >= ceilingMs) {
      return {
        sha: headSha, status: 'timeout', reason: 'wait-timeout', ok: false,
        detail: `still not settled after waiting ${elapsed}ms (ceiling ${ceilingMs}ms) — last read: ${v.status} (${v.reason}). Still running: re-run the same bounded \`check --wait=\` (the dispatcher's own ceilings settle a hung request as an infrastructure-failure); never reset or re-request automatically.`,
        settled: false, waited: { ms: elapsed, polls }, lastStatus: v.status, lastReason: v.reason,
      };
    }
    await sleep(Math.min(pollIntervalMs, ceilingMs - elapsed));
  }
}

/**
 * THE FINISH-GUARD DECISION (#2833). Given the lane's verification `record` and the `headSha` a delivery step
 * (pr-land) is about to land, decide whether that HEAD is verified enough to deliver. Pure — no fs/git/clock.
 *
 * #3321 — `requireVerified` DEFAULTS TRUE here, not just in `resolveVerifyOptions`. A caller that omits the
 * option gets the strict gate: the failure mode this closes is precisely a gate that allows when it cannot tell.
 * Read every "`requireVerified` false" cell below as "under the explicit `--no-require-verified` opt-out".
 *
 *   - `breakGlass` (env `WE_LAND_UNVERIFIED=1`) → ALWAYS ok, flagged. The deliberate documented override so a
 *     guard bug / a legitimately-CI-only land is never permanently wedged (house style: `WE_MERGE_BREAK_GLASS`).
 *     This is the FULL bypass — the opt-out is not: it leaves stall and corrupt refusing.
 *   - a `green` record whose `sha` === `headSha` → ok (`verified`). The one clean pass.
 *   - a `running` record whose `sha` === `headSha` → the EXACT observed stall: a verification was started for
 *     this commit and never finished. A FRESH (in-flight) `running` marker is NOT ok (`verify-unfinished`) — a
 *     half-run verification must never look complete. But a PAST-TTL `running` marker (the writer is presumed
 *     gone) must not wedge an opted-out CI-gated caller forever: past-TTL AND `requireVerified` false ⇒ DEGRADE
 *     to the non-blocking `untracked` verdict (the required CI check still gates the merge) — #2833 finding 1.
 *     Under `requireVerified` — now the DEFAULT (#3321) — it stays refused even when abandoned: that path demands
 *     a real green. That is not a wedge, because re-running `verify-lane` legitimately overwrites a `running`
 *     marker for the same sha (its start-write refuses only to clobber a TERMINAL record for a FOREIGN sha).
 *   - a `red` record whose `sha` === `headSha`: refused (`verify-red`) ONLY under `requireVerified`; without it
 *     the marker is advisory and the record is allowed (`red-ci-gated`). This is the asymmetry between the two
 *     hazard classes — "never finished" (`running`) is always refused; "finished badly" (`red`) blocks only when
 *     the caller demanded a local green. It matches the "absent/red under `--require-verified`" contract in the
 *     PR body + #2833 resolution. THIS CLAUSE USED TO END "...and keeps the CI-gated drain / parallel-workflow
 *     paths (which gate the merge via the required GitHub `test` check — a red tree also fails it) UNTOUCHED, as
 *     documented." THAT WAS WRONG, and it is the exact error #3321's review caught: those paths passed NOTHING,
 *     and after the flip "nothing" resolves to `requireVerified: true`, so they were not kept untouched — they
 *     were silently switched to the strict gate and would have refused every couple. They are untouched only
 *     NOW, because BOTH were changed to pass `--no-require-verified` explicitly: `we:scripts/lane-drain.mjs`
 *     (in `buildPrLandArgs`) and `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` (all four
 *     pr-land invocations — the two per-lane PR opens and the two Finalize label-reconcile calls). The first
 *     retraction of this clause named only the drain and left the parallel-workflow half asserted-but-unfixed,
 *     which review round 2 caught: a retraction that fixes one of the two callers it names is still a false
 *     claim. Inverting a default is a change to every caller that says nothing; it cannot leave them "unchanged"
 *     by construction.
 *   - a `corrupt` record (the marker exists but did not parse) → NOT ok (`verify-corrupt`), regardless of
 *     `requireVerified`. A torn/garbled marker must never fold into `absent` and fail OPEN — exactly backwards
 *     for a stall guard (#2833 finding 5). Re-run `verify-lane` (or delete the marker) to recover.
 *   - no record, or a record for a DIFFERENT `sha` (stale — the tree moved on): if `requireVerified` → NOT ok
 *     (`unverified`); else ok (`untracked`). #3321 flipped which of those is the default. THIS is the cell the
 *     item exists for: "no marker" used to mean "not tracked here, go ahead", so a lane whose suites had never
 *     run landed on the strength of the gate not knowing. It now means "unverified — run `verify-lane`". The
 *     permissive `untracked` verdict survives only for a caller that explicitly opts out (`--no-require-verified`)
 *     because it verifies elsewhere. That is not hypothetical and must not be left as an "e.g.": the callers are
 *     `buildPrLandArgs` in `we:scripts/lane-drain.mjs` and the four pr-land invocations in
 *     `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` — both land from a checkout where a lane
 *     clone's marker can never appear, and both are gated by the required GitHub check (#1937). If either call
 *     site drops the flag, this cell wedges that whole path — see the test that pins the built argv through this
 *     function in `we:scripts/__tests__/lane-drain.test.mjs`.
 *     Note a MISSING `headSha` also lands here (nothing can match it), and so is refused by default rather than
 *     waved through: not being able to identify the tree is not evidence that the tree is fine.
 *
 * #4296 — `laneRelevantChangeSince` KEYS THE MARKER TO WHAT CHANGED, NOT THE EXACT COMMIT. Before this item,
 * `matches` demanded `rec.sha === headSha` — any new commit on the lane, including a no-op merge of `base` that
 * conflicts only on a file the lane itself never touches, invalidated a green marker and forced a full re-run
 * (evidence: a mid-work merge that conflicted solely on a file outside the lane's own touch-set). The caller
 * (`verify-lane.mjs check`, `pr-land.mjs`'s finish-guard) now MAY pass the precomputed overlap between "what
 * changed since the marker's recorded sha" and "what this lane still touches" — `verify-lane-gate.mjs`'s
 * `laneRelevantChangeSince` (via its `laneRelevantChangeSinceForRecord` wrapper), the IO half this pure core
 * cannot own.
 * An EMPTY array promotes a stale-sha record to a match (the marker still covers `headSha`); `undefined` (the
 * caller never computed it — every EXISTING caller and unit test that omits this param) or `null` (git could not
 * tell) never does — fail closed, exactly like every other "unknown" cell in this gate.
 * @returns {{ ok:boolean, status:string, reason:string, detail:string }}
 */
export function verifyGateDecision({ record, headSha, nowMs = Date.now(), ttlMs = DEFAULT_VERIFY_TTL_MINUTES * 60_000, breakGlass = false, requireVerified = true, laneRelevantChangeSince } = {}) {
  if (breakGlass) {
    return { ok: true, status: 'break-glass', reason: 'break-glass', detail: 'WE_LAND_UNVERIFIED=1 — verification gate overridden (deliberate break-glass; the PR still rides the required CI check).' };
  }
  const rec = record && typeof record === 'object' ? record : null;

  // A marker that exists but did not parse (the IO layer signals `{ corrupt: true }`) is refused unconditionally
  // — never treated as `absent`, which would fail open (#2833 finding 5).
  if (rec && rec.corrupt) {
    return { ok: false, status: 'corrupt', reason: 'verify-corrupt', detail: 'the lane verification marker exists but is unparseable (corrupt/torn) — refusing to land; re-run `node scripts/verify-lane.mjs` (or delete the marker) to record a clean result.' };
  }

  const exactShaMatch = !!(rec && rec.sha && headSha && rec.sha === headSha);
  // #4296 — a STALE-sha record still covers `headSha` when nothing lane-relevant changed since it was recorded.
  // Only an actually-computed EMPTY overlap promotes this; `undefined`/`null` never do (see the doc above).
  const coveredByUnchangedRelevantSet = !exactShaMatch && !!(rec && rec.sha && headSha)
    && Array.isArray(laneRelevantChangeSince) && laneRelevantChangeSince.length === 0;
  const matches = exactShaMatch || coveredByUnchangedRelevantSet;
  const carriedForwardNote = coveredByUnchangedRelevantSet
    ? ` (recorded for ${String(rec.sha).slice(0, 8)}; carried forward to ${String(headSha).slice(0, 8)} — no lane-relevant file changed since)`
    : '';

  if (matches && rec.status === 'green') {
    return { ok: true, status: 'green', reason: 'verified',
      ...(rec.retriedTimeouts?.length ? { retriedTimeouts: rec.retriedTimeouts } : {}),
      detail: `lane verified green for ${String(headSha).slice(0, 8)}${carriedForwardNote} (suites: ${rec.suites || 'recorded'}).${describeTimeoutRetry(rec.retriedTimeouts)}` };
  }
  if (matches && rec.status === 'running') {
    const abandoned = isVerifyAbandoned(rec, nowMs, ttlMs);
    // #2833 finding 1 — the TTL must actually GATE, not just re-word. A stranded `running` marker that has
    // outlived its TTL (the writer is presumed gone) must NOT wedge the CI-gated drain forever: past-TTL AND
    // `requireVerified` false ⇒ DEGRADE to the non-blocking `untracked` verdict (the required GitHub check still
    // gates the merge). Fail-CLOSED otherwise: a FRESH (in-flight) `running` marker is the exact observed stall
    // and is always refused; and under `requireVerified` (the solo/conveyor build gate) even an abandoned run is
    // refused — that flow demands a real local green, never a timed-out one.
    if (abandoned && !requireVerified) {
      return {
        ok: true, status: 'untracked', reason: 'untracked',
        detail: `verification for ${String(headSha).slice(0, 8)} was left UNFINISHED (a backgrounded run that never completed; started ${rec.startedAt || '?'}) and has outlived its TTL (${Math.round(ttlMs / 60_000)}m) — treating it as untracked so a stranded marker cannot wedge the CI-gated drain (#2833 finding 1); the PR's required CI check still gates the merge. Re-run \`node scripts/verify-lane.mjs\` to record a fresh green.`,
      };
    }
    return {
      ok: false, status: 'running', reason: 'verify-unfinished',
      detail: `verification for ${String(headSha).slice(0, 8)} is UNFINISHED (${abandoned ? 'abandoned — a backgrounded run that never completed' : 'still in-flight'}; started ${rec.startedAt || '?'}). A half-run verification must not look complete — re-run \`node scripts/verify-lane.mjs\` to completion (foreground, blocking) before landing.`,
    };
  }
  const infrastructure = rec?.infrastructure || verificationInfrastructureFailure({ exitCode: rec?.exitCode, signal: rec?.signal });
  if (matches && (rec.status === 'infrastructure-failure' || (rec.status === 'red' && infrastructure))) {
    const reason = infrastructure?.reason || 'verify-infrastructure';
    const detail = infrastructure?.detail || 'verification infrastructure failed; no test verdict. Inspect the runner log before retrying.';
    if (requireVerified) return { ok: false, status: 'infrastructure-failure', reason, detail };
    // Advisory mode — same contract as a red marker below: a killed/timed-out gate is a terminal record with no TTL
    // escape, so blocking here would wedge every CI-gated flow on each kill until a manual reset. This caller opted
    // out of mandatory verification, so report it honestly (status stays `infrastructure-failure`) but do not block;
    // the PR's required CI check gates the merge.
    return { ok: true, status: 'infrastructure-failure', reason,
      detail: `${detail} This caller opted out of mandatory verification (--no-require-verified / WE_REQUIRE_VERIFIED=0) — not blocking here; the PR's required CI check gates the merge.` };
  }
  if (matches && rec.status === 'red') {
    const diagnostic = exactShaMatch ? {
      ...(rec.failureDetails ? { failureDetails: boundFailureDetails(rec.failureDetails) } : {}),
      ...(rec.retriedTimeouts?.length ? { retriedTimeouts: rec.retriedTimeouts } : {}),
    } : {};
    const retryDetail = describeTimeoutRetry(diagnostic.retriedTimeouts);
    if (requireVerified) {
      return { ok: false, status: 'red', ...diagnostic, reason: 'verify-red', detail: `verification for ${String(headSha).slice(0, 8)} recorded a RED result (exit ${rec.exitCode ?? '?'}) — fix the failure and re-run \`node scripts/verify-lane.mjs\`.${retryDetail}` };
    }
    // Advisory mode: the required CI check (which a red tree also fails) gates the actual merge, so a local red
    // marker does not block here — matching "absent/red under --require-verified" (docs + #2833 resolution).
    return { ok: true, status: 'red', ...diagnostic, reason: 'red-ci-gated', detail: `verification for ${String(headSha).slice(0, 8)} recorded RED (exit ${rec.exitCode ?? '?'}), but this caller opted out of mandatory verification (--no-require-verified / WE_REQUIRE_VERIFIED=0) — not blocking here; the PR's required CI check gates the merge.${retryDetail}` };
  }

  // No marker, or a marker for a different commit (the tree moved since it was written).
  const why = rec ? `the recorded verification is for ${String(rec.sha).slice(0, 8)}, not the HEAD being landed (${String(headSha).slice(0, 8)})` : 'no verification marker for this lane';
  if (requireVerified) {
    return { ok: false, status: 'absent', reason: 'unverified', detail: `${why} — verification is MANDATORY before a lane lands (#3321): run \`node scripts/verify-lane.mjs\` (a foreground, blocking suite run) to record a green result for this HEAD. Deliberate escapes: --no-require-verified when the lane is verified elsewhere, or WE_LAND_UNVERIFIED=1 to override the gate entirely.` };
  }
  return { ok: true, status: 'untracked', reason: 'untracked', detail: `${why} — this caller opted out of mandatory verification (--no-require-verified / WE_REQUIRE_VERIFIED=0), so the marker is advisory here (the PR's required CI check still gates the merge).` };
}


/** #4161 — a fresh lease is sufficient unless the same-host holder is provably dead. */
export function verifyServerVerdict({ leaseStatus, pidLiveness }) {
  if (leaseStatus.held && pidLiveness !== 'dead') return { alive: true, owner: leaseStatus.owner };
  return { alive: false, reason: leaseStatus.held ? 'holder-dead' : leaseStatus.stale ? 'stale-lease' : 'no-lease' };
}
