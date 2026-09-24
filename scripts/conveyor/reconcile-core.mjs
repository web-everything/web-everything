/**
 * reconcile-core.mjs — the PURE reconcile pass (#3296): compare DESIRED delivery state against ACTUAL, for
 * every open PR, and return what to dispatch plus every refusal and the fact each turned on.
 *
 * WHY THIS EXISTS. Nothing in the tree reconciles an open PR against a live process. `planTick`'s two spawns are
 * gated on `if (!launched.has(normNum(p.num))) continue; // only PRs THIS conveyor launched`
 * (`we:scripts/conveyor/tick-core.mjs:396` for fixes, `:495` for CI-heals), and `launchedNums` is
 * SESSION-EPHEMERAL bookkeeping piped in over STDIN — so the moment the supervising session exits, every PR it
 * launched becomes a PR no conveyor launched, owned by nothing. `planTick`'s `decisions`
 * (`we:scripts/conveyor/tick-core.mjs:855-866`) contain no review spawn at all, so a `review:pending` PR is
 * WATCHED and never WORKED. The residue is a person: a human dispatched every reviewer and every healer that ran
 * today.
 *
 * THE COMMON THREAD, and the reason this is one item rather than six fixes: every failure is **a proxy standing
 * in for a fact nobody checks**. A session's `launchedNums` stands in for ownership. A label stands in for a
 * process. A file mtime stands in for liveness. A resolved card stands in for an idle lane. This pass replaces
 * the proxies with the facts, and where it cannot get a fact it says so out loud instead of guessing.
 *
 * KEYED BY PR NUMBER, NEVER BY ITEM NUMBER. This is not a preference. Measured 2026-08-26 17:34Z, all four open
 * PRs' head refs (`lane/review-slice-scopes`, `lane/review-pr-override-reason`, `lane/review-corpus-replay`,
 * `lane/review-efficacy-watch`) return `null` from `laneRefItemNum`
 * (`we:scripts/conveyor/lease-reaper.mjs`), whose grammar is `^lane/(x[a-z0-9]{5,7}|\d+)[a-z]?-`. An item-keyed
 * pass would therefore have seen ZERO of the four PRs it exists to reconcile. `reconcile-core.test.mjs` pins that
 * difference as an assertion rather than leaving it as a design note.
 *
 * PHASE IS BORROWED, NOT RE-DERIVED. `classifyPr` (`we:scripts/progress-board.mjs`) gives the label phase and
 * `reduceCheckState` (`we:scripts/operations/pr-status.mjs`, #3247) gives CI truth. A second derivation is the
 * defect, not the feature — it is how the board and the reconciler come to disagree about what a PR is doing. If
 * this pass ever needs a fact those two do not expose, WIDEN THEM; do not grow a private copy here.
 *
 * ON `pr-status`'s OWN WORDING: its `CHECK_STATES` is a frozen list of FOUR — `green`, `red`, `pending`,
 * `unchecked` — while the docblock above it says "three-valued". Four is what it freezes and four is what this
 * file consumes, because the distinction that matters here is exactly the fourth: `unchecked` is NOT a flavour of
 * `pending`. Zero check runs on a head means nothing has been asked about that commit, which never satisfies a
 * gate. Do not inherit the "three-valued" phrasing.
 *
 * THE DISPATCH IS THE EASY HALF — THE FOUR REFUSALS ARE THE ITEM:
 *
 *   1. `stood-down` is TERMINAL. An agent that stopped to ask a question is never restarted; re-running it
 *      re-asks the question forever and burns tokens. Read from the durable marker
 *      `we:scripts/conveyor/stand-down.mjs` posts — no decay, no clock, so the verdict is identical a week later.
 *   2. NO FINDINGS, NO FIXER. A PR with nothing to fix must never receive a fix agent; it will invent work. The
 *      right answer for a `review:pending` PR with no findings is a REVIEW, not a fix.
 *   3. THE ROUND CAP SURVIVES A RESTART, OR IT IS NOT A CAP. The attempt count is derived from the PR and ONLY
 *      from the PR. No in-process tally is read here — not as a floor, not as an overlay, not at all. Measured:
 *      `countRearmComments` read `0` on all four open PRs, and read `0` on `#1563` through all TWELVE of its
 *      review rounds against a `NEGOTIATION_ROUND_CAP` of 5. A cap that resets on restart is not a cap.
 *   4. LIVENESS COMES FROM A LIVE PROCESS — AND THE LISTING IS THINNER THAN IT LOOKS. See below; this is the one
 *      that pins cause 6, and the one most likely to be "simplified" into a bug.
 *
 * REFUSAL 4 IN FULL, because every part of it was measured and every part of it is a trap.
 *
 *   • THE LISTING IS PARTIAL. Over the 17 live sessions `claude agents --json` returned at 17:34Z, the union of
 *     keys is exactly `cwd, id, kind, name, pid, sessionId, startedAt, state, status, waitingFor`. Only
 *     `cwd`/`kind`/`name`/`sessionId`/`startedAt` appear on all 17. `pid` appears on 13, `state` on 7, and
 *     `status` + `waitingFor` on 3. **A missing `pid` is not a dead process and a missing `state` is not a
 *     healthy one.** Absence is UNKNOWN, and unknown refuses — it never reads as idle.
 *   • THE LISTING CARRIES NO PR. There is no `pr`, `item`, `num`, `branch` or `ref` field on ANY entry, so the
 *     PR↔session binding must be DERIVED. For a build/prepare dispatch the only derivation available is `cwd` →
 *     that lane's `HEAD` → the PR's `headRefOid`, and that rule PRODUCED A FALSE POSITIVE while #3296 was being
 *     prepared: it bound the preparing session to PR `#1571`, because a second agent had reset the shared
 *     `lane-35` checkout to `#1571`'s head underneath it (`#3283`, observed live rather than argued). So the
 *     binding is ITSELF a proxy. For a REVIEW dispatch it is worse than a rare false positive — it essentially
 *     NEVER matches at all: `review-dispatch.mjs` spawns the review agent with `cwd: REPO_ROOT` (the primary
 *     checkout) and its brief never `cd`s into the lane it later acquires for itself, so the cwd/oid rule reads
 *     the wrong checkout's HEAD on every review session, first round or re-armed (#3437, confirmed live
 *     2026-09-01: SEVEN independent sessions spawned across ~15 minutes against one re-armed PR, because none
 *     ever bound). {@link bindAgents} therefore carries a SECOND bind path for this dispatch kind — the session
 *     `name` (`review-<pr>`, 100% populated on a review-dispatch session, unlike `pid`/`state`) — unioned with
 *     the cwd/oid path rather than replacing it, since no PR-specific session name exists for build/prepare.
 *     Every liveness refusal still carries the `cwd` and the `sha` it turned on — `sha` is always the PR's own
 *     `headRefOid`, so when only the name path matched it reads as evidence the reader can compare against the
 *     bound agent's OWN `laneHeadOid` (they will differ, which is exactly what proves the cwd/oid path did not
 *     catch it). Widening the listing to carry a PR field would fix the cwd/oid path properly — it is a change
 *     to a tool this repo does not own, so it is named, not absorbed.
 *   • `waitingFor: 'permission prompt'` IS A FIFTH STATE, neither alive nor dead. Three sessions have held one
 *     for 211.4 hours. It refuses dispatch AND surfaces under its own kind, or the 211-hour case repeats
 *     silently.
 *   • A TIMESTAMP IS NOT A HEARTBEAT. `we:scripts/readiness/conveyor-state.mjs` treats a transcript's mtime as
 *     its last-activity clock, and it is right to within what a timestamp can mean — but a transcript stops
 *     being written when an agent FINISHES exactly as it does when an agent DIES. So `transcriptMtimeMs` is
 *     carried through this file as EVIDENCE ONLY and is never read by any decision: **freshness never grants
 *     liveness, and staleness never withdraws it.** A live `pid` refuses however stale its transcript is; a fresh
 *     transcript with no agent entry behind it still dispatches. That asymmetry is load-bearing and
 *     `reconcile-core.test.mjs` pins both halves — a change that reddens both has removed the wrong thing.
 *
 * EVERY PR PRODUCES A ROW. A pass that refuses four PRs and prints one line has reproduced the original defect
 * one level up, so nothing is dropped silently: each open PR yields either a dispatch or a refusal, and each
 * refusal names its kind, its PR, and the fact it turned on. {@link planReconcile} guarantees the row count
 * equals the PR count.
 *
 * WHAT THIS PASS DOES NOT DO: it does not RUN a review (the review loop and its converged / exhausted / stuck
 * vocabulary are #3072); it does not spawn the reviewer session (#3279 declares that operation — this decides
 * that a review is owed and calls it); it does not dispose a `review:pending` PR from a jury ledger
 * (`we:scripts/review-runner.mjs` owns that, and its shadow→enforce flip is #2572 part 2); it does not reap a
 * permission-blocked session (it SURFACES the 211-hour case; clearing it is a separate job); and it changes no
 * label's meaning and adds no label — the stand-down signal is a comment marker.
 *
 * PURE: no fs, no clock, no process, no network. Every impure fact (a `pid`'s liveness, a lane's `HEAD`, a
 * transcript's mtime) is INJECTED on the input records by `we:scripts/conveyor/reconcile-pass.mjs`, so every
 * branch below is reachable in a test with no network and no credential.
 */
import { classifyPr } from '../progress-board.mjs';
import { reduceCheckState } from '../operations/pr-status.mjs';
import { NEGOTIATION_ROUND_CAP } from '../lib/jury-core.mjs';
import { countRearmComments, REARM_COMMENT_MARKER } from './rearm-review.mjs';
// #3383 — see this module's own REFUSAL 3 note below, and `advisory-round-count.mjs`'s header for the
// `#2117`/`#2298` incident this closes.
import { countAdvisoryComments } from './advisory-round-count.mjs';
import { countCiHealComments, CI_HEAL_COMMENT_MARKER } from './ci-heal-mark.mjs';
import { countTerminalStandDowns, STAND_DOWN_MARKER, SUPERSEDE_STAND_DOWN_MARKER } from './stand-down.mjs';
import { reviewSessionSlug } from './review-session-slug.mjs';
// Both dispatcher wrappers delegate to the pure session-slug module.
import { sessionSlugFor } from '../operations/dispatch-lane.mjs';
// #xkmu3gv — two NEW, narrow populations, each with its OWN durable marker/cap (see each leaf's own header):
// a mechanical conflict-resolution round (routed by `origin/lane/xdhidso-review-human-statute-fixer`, PR #2577)
// and an advisory-fix round on a `needs-human` PR carrying `advisory:changes`. Both are true leaves — no fs, no
// clock, no process, no network — so importing them keeps this file PURE and leaf-light exactly as its own
// header requires.
import { countConflictFixComments, CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import { countAdvisoryFixComments, ADVISORY_FIX_COMMENT_MARKER } from './advisory-fix-mark.mjs';
import { CONFLICT_LABEL } from './conflict-label.mjs';
import { ADVISORY_LABELS } from '../lib/advisory-labels.mjs';

/**
 * we:scripts/conveyor/reconcile-core.mjs#DISPATCH_KINDS — the three things this pass ever asks for. Frozen,
 * because the list being SHORT is the design: the pass decides that work is owed and who owes it, and it runs
 * nothing itself. `fix` re-dispatches the fix-agent brief at a bounced PR; `review` calls the independent-review
 * operation (#3279); `ci-heal` re-dispatches the CI-heal brief at a red-CI PR (multi-repo slice 7,
 * `we:backlog/3967-*.md`).
 *
 * `ci-heal` WAS deliberately absent here (`planTick` already planned those) — see `we:scripts/conveyor/
 * tick-core.mjs#planCiHealSpawns`. That path stayed exactly as it is: it heals a WE PR THIS SESSION'S OWN
 * `launchedNums` remembers launching, session-ephemeral bookkeeping that a restart wipes. This pass closes the
 * gap that leaves — a red PR opened by hand, one a sibling process launched, or a restart-orphaned one, in ANY
 * constellation repo — the SAME genuinely-different-population reasoning `reconcile-fix-dispatch.mjs`'s own
 * docblock gives for `fix` (multi-repo slice 5, `#x33jgwt`). The two paths are not a duplicate mechanism for
 * the two reasons `bindAgents`/`assessLiveness` below now enforce: a `ci-heal-<pr>` session name binds here
 * exactly like `fix-<pr>` already did, so a heal `planTick` already launched refuses `live-process` rather than
 * being re-planned, and the cap is the SAME durable floor (`countCiHealComments`) either path would read off
 * the PR, never two independent counters.
 */
export const DISPATCH_KINDS = Object.freeze(['fix', 'review', 'ci-heal']);

/**
 * we:scripts/conveyor/reconcile-core.mjs#REFUSAL_KINDS — every reason this pass declines to dispatch. Frozen and
 * exhaustive: a refusal that is not on this list is a bug, because a refusal this file cannot NAME is a refusal a
 * reader cannot audit.
 *
 *   `stood-down`         — a fixer already stopped to ask here (terminal; a person clears it).
 *   `no-findings`        — nothing to fix; a fixer would invent work.
 *   `cap-exhausted`      — the PR's own durable attempt count is at or above the cap.
 *   `live-process`       — a bound session has a LIVE pid. Something is already working this PR.
 *   `awaiting-permission`— a bound session is blocked on a permission prompt: the fifth state, neither alive nor
 *                          dead. Refuses AND surfaces, because nobody is coming to answer it.
 *   `liveness-unknown`   — a session is bound but its `pid` is absent or unprobed. Absence of a field is never
 *                          evidence of death, so this refuses rather than dispatching over a possibly-live agent.
 *                          If the session is CONFIRMED stuck by other means (GH #77683 — listed forever, and
 *                          `claude stop`/`claude rm` fail or silently no-op against it), the fix is
 *                          `we:scripts/operations/clear-stuck-session.mjs` (`node scripts/operations/run.mjs
 *                          clear-stuck-session --session=<id>`), which replays THIS function's own verdict
 *                          rather than re-deriving a second one — never a manual `~/.claude/jobs/<id>/` move.
 *   `owed-elsewhere`     — real work is owed, by a job this pass does not run (a human clear, a CI heal, a
 *                          rebase). Named rather than dropped, so the PR is visible in the report.
 *   `nothing-owed`       — the PR is reviewed and queued, or already landed. Genuinely nothing to do.
 */
export const REFUSAL_KINDS = Object.freeze([
  'stood-down', 'no-findings', 'cap-exhausted',
  'live-process', 'awaiting-permission', 'liveness-unknown',
  'owed-elsewhere', 'nothing-owed',
]);

/**
 * we:scripts/conveyor/reconcile-core.mjs#BOOKKEEPING_MARKERS — the durable conveyor marker comments, which are
 * this loop's OWN bookkeeping and must never be mistaken for a reviewer's finding. A PR whose only comments are
 * three re-arm markers has had zero findings raised on it, and dispatching a fixer at it is exactly the
 * invent-work failure refusal 2 exists to prevent. Single-sourced from the files that POST them so this
 * list cannot drift from what is actually on a PR. The parked-PR conflict watch's supersede comment
 * (`SUPERSEDE_STAND_DOWN_MARKER`, #xu2krte Fork 2) is bookkeeping too — it says a stand-down no longer holds,
 * it raises no finding.
 */
export const BOOKKEEPING_MARKERS = Object.freeze([
  REARM_COMMENT_MARKER, CI_HEAL_COMMENT_MARKER, STAND_DOWN_MARKER, SUPERSEDE_STAND_DOWN_MARKER,
  // #xkmu3gv — the two new completed-round markers. Neither is a reviewer speaking, so neither may ever count as
  // a finding (`countFindings`) or the pass would read its OWN handback comment as fresh work to fix.
  CONFLICT_FIX_COMMENT_MARKER, ADVISORY_FIX_COMMENT_MARKER,
]);

/**
 * The label phases where this pass has something to dispatch, and what it dispatches. Everything else is a
 * refusal — `owed-elsewhere` when a phase means real work by someone else, `nothing-owed` when it does not.
 * `classifyPr` produces the keys; they are not re-derived here.
 *
 * `needs-human` dispatches a `review` too (live-caught 2026-09-23, item xpprcdz: PR #2486/#2492, both
 * `review:human` from open, sat with zero advisory-panel comments and no status label — nothing ever ran
 * `we:scripts/operations/review-pr.mjs` against them, so its own `advise` step — built exactly for this
 * population, an automatic PR comment plus an `advisory:*` label that never touches `review:human` or
 * `review:accepted` — never fired). Dispatching `review` here does not clear the human gate: `review-pr.mjs`'s
 * own `confirm` step still suspends waiting on an operator; only `advise`, `record`'s label swap is untouched.
 * The existing round cap already covers this population — `countAdvisoryComments` below was unioned in
 * specifically because a PR that is ALSO `review:human` can round forever without a rearm comment ever posting
 * (#2117), so a `needs-human` PR that keeps re-dispatching still hits `cap-exhausted` once its own advisory
 * comments reach `roundCap`, same as today's `bounced`+`review:human` population.
 */
const OWED = Object.freeze({ bounced: 'fix', 'needs-review': 'review', 'needs-human': 'review' });
const OWED_ELSEWHERE = Object.freeze({
  conflicted: 'the branch needs a rebase before it can merge',
});

/**
 * we:scripts/conveyor/reconcile-core.mjs#CI_HEAL_ROUND_CAP — the durable CI-heal attempt cap `ci-red` binds on
 * (multi-repo slice 7). Mirrors `we:scripts/conveyor/tick-core.mjs#DEFAULT_CI_HEAL_RETRY_CAP` (3) exactly —
 * DUPLICATED, not imported, because `tick-core.mjs` already imports THIS module (its own `planCiHealSpawns`
 * path, see {@link DISPATCH_KINDS}'s docblock), so importing back would be circular. Both floors move together
 * by hand if the retry policy ever changes; `reconcile-core.test.mjs` and `tick-core.test.mjs` each pin their
 * own copy's value so a drift between them fails loud in CI rather than silently diverging.
 */
export const CI_HEAL_ROUND_CAP = 3;

/**
 * we:scripts/conveyor/reconcile-core.mjs#CONFLICT_FIX_ROUND_CAP — the durable cap a MECHANICAL
 * conflict-resolution round binds on (#xkmu3gv). Mirrors {@link CI_HEAL_ROUND_CAP} exactly: its OWN, smaller
 * cap, counted by `we:scripts/conveyor/conflict-fix-round-count.mjs#countConflictFixComments` — never
 * `roundCap`'s shared rearm/advisory counters, and never reduced by however many ordinary negotiation rounds a
 * PR has already spent (CONFIRMED LIVE: `chalbert/web-everything#2549` was already at 5 of 5 ordinary rounds
 * when PR #2577's routing rule newly offered it a conflict fix, and the shared cap refused it before the fixer
 * ever ran — see that leaf's own header for the full incident). A PR that ALSO exhausts three
 * conflict-resolution rounds still needs a person, exactly as an exhausted `roundCap` does.
 */
export const CONFLICT_FIX_ROUND_CAP = 3;

/**
 * we:scripts/conveyor/reconcile-core.mjs#ADVISORY_FIX_ROUND_CAP — the durable cap an ADVISORY-FIX round on a
 * `needs-human` PR binds on (#xkmu3gv). Mirrors {@link CI_HEAL_ROUND_CAP} exactly: its OWN, smaller cap, counted
 * by `we:scripts/conveyor/advisory-fix-mark.mjs#countAdvisoryFixComments` — never `roundCap`'s shared
 * rearm/advisory counters. Deliberately its own cap, not `roundCap`: an advisory-fix round and an ordinary
 * review<->fix negotiation round are different work (repairing an admitted, narrow advisory finding vs. a
 * human's own substantive back-and-forth), so binding them to one shared counter would let a PR that already
 * spent its ordinary rounds on real negotiation never get an advisory fix at all — exactly the gap #xkmu3gv
 * closes.
 */
export const ADVISORY_FIX_ROUND_CAP = 3;

/** Narrow a raw `gh` label array (`[{name}]`, or bare strings) to the names it carries. Pure. */
const labelNames = (labels) => (Array.isArray(labels) ? labels : [])
  .map((l) => (typeof l === 'string' ? l : l?.name))
  .filter(Boolean);

/** The body of one comment, as `gh pr view --json comments` returns it (`[{ body }]`); bare strings tolerated. */
const commentBody = (c) => (typeof c === 'string' ? c : c?.body);

/**
 * we:scripts/conveyor/reconcile-core.mjs#startedAtMs — `startedAt` as epoch ms, whichever shape it arrives in.
 *
 * MEASURED, NOT ASSUMED: `claude agents --json` returns `startedAt` as an epoch NUMBER
 * (`1787004649412` — `2026-08-17T22:10:49.412Z`), not the ISO string it reads like in a written-out listing.
 * `Date.parse(1787004649412)` is `NaN`, so a parser that accepted only the string shape would compute no age at
 * all — and would do it SILENTLY, dropping the "held for N hours" figure out of the one note whose entire job is
 * to make a 217-hour block impossible to overlook. The failure would have looked like a formatting nicety and
 * been exactly the defect this pass exists to remove, one level up. Both shapes are accepted, and both are
 * pinned in `reconcile-core.test.mjs`.
 * @param {string|number|null|undefined} startedAt
 * @returns {number} epoch ms, or `NaN` when it cannot be read
 */
export function startedAtMs(startedAt) {
  if (typeof startedAt === 'number') return Number.isFinite(startedAt) ? startedAt : NaN;
  if (typeof startedAt === 'string') {
    const trimmed = startedAt.trim();
    // A numeric STRING is an epoch too — `Date.parse('1787004649412')` is NaN, so it must not reach it.
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return Date.parse(trimmed);
  }
  return NaN;
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#countFindings — how many comments on this PR are a REVIEWER speaking,
 * rather than the conveyor talking to itself. A comment whose LEADING line is one of
 * {@link BOOKKEEPING_MARKERS} is this loop's own record and is not a finding. Pure.
 *
 * The leading-line narrowing matches `countRearmComments`'s, and for the same reason: a human who QUOTES a
 * marker comment in their reply is raising a finding, not posting a marker, and must not be discounted.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number}
 */
export function countFindings(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (const c of comments) {
    const body = commentBody(c);
    if (typeof body !== 'string') continue;
    const head = body.trimStart();
    if (BOOKKEEPING_MARKERS.some((m) => head.startsWith(m))) continue;
    n += 1;
  }
  return n;
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#bindAgents — derive which live sessions are working THIS PR, and return
 * them with the evidence the derivation turned on. Pure. Two independent bind paths, UNIONED (#3437 — a review
 * dispatch essentially never matches the first one; see below):
 *
 * PATH 1 — `cwd` → that lane's `HEAD` → the PR's `headRefOid`. THE BINDING IS A PROXY AND IT IS RETURNED AS ONE.
 * `claude agents --json` carries no `pr`, `item`, `num`, `branch` or `ref` field on any entry — measured over
 * all 17 live sessions — so this is the only rule available for a build/prepare dispatch, which carries no
 * PR-specific session identity at all. `laneHeadOid` is resolved by the IO shell (this file cannot read a git
 * ref) and compared here. The rule is known to produce false positives when two agents share a checkout and one
 * resets it under the other (#3283, observed live at 17:34Z). A blank/absent `headRefOid` or `laneHeadOid` binds
 * NOTHING on this path — two unknowns are not a match, and treating them as one would bind every session to
 * every PR.
 *
 * PATH 2 — session `name` === `review-<pr>` OR `fix-<pr>`. THIS PATH EXISTS BECAUSE PATH 1 CANNOT EVER MATCH A
 * REVIEW-DISPATCH SESSION, first round or re-armed, working or not (#3437, confirmed live 2026-09-01: SEVEN
 * independent `review-1765` sessions spawned across ~15 minutes of ticks against one re-armed PR, because none
 * ever bound).
 * `we:scripts/operations/review-dispatch.mjs` spawns the review agent with `cwd: REPO_ROOT` — the PRIMARY
 * checkout, per that file's own docblock — and the review agent's own brief never `cd`s the agent's shell into
 * the lane it later acquires for itself (the lane is a flag to a subprocess, not the agent's own cwd). So
 * `resolveLaneHead(cwd)` for a `review-<pr>` session always reads the PRIMARY checkout's HEAD, which essentially
 * never equals `pr.headRefOid` — path 1 is not "rare false positives" for this dispatch kind, it is a near-total
 * miss. What a review-dispatch session DOES carry, 100% of the time, is a PR-specific `name`
 * (`we:scripts/conveyor/review-session-slug.mjs#reviewSessionSlug`, spawned via `-n <slug>` and echoed verbatim
 * on every `claude agents --json` entry — unlike `pid`/`state`, `name` is on all 17 measured entries). Matching
 * on it needs no `headRefOid` at all, so it still binds when path 1's sha is blank.
 *
 * THE SAME NAME-BASED GAP APPLIES TO A FIX DISPATCH (#3438), and for the identical reason: once a
 * `we:scripts/conveyor/reconcile-fix-dispatch.mjs` fix agent has made its first commit in its acquired lane, its
 * lane's `HEAD` has advanced past the PR's still-unpushed `headRefOid` — path 1 goes blind at exactly the moment
 * the fix agent starts doing real work, which is the #3437 double-dispatch shape recurring one dispatch kind
 * over. `fix-<pr>` (`we:scripts/operations/dispatch-lane.mjs#sessionSlugFor(pr, 'fix')`) is ALREADY the session
 * name both `dispatch-lane.mjs`'s own tick-core-driven fix dispatch (#3332) and `reconcile-fix-dispatch.mjs`
 * spawn a fix agent under, so matching it here needs no new naming scheme, only reading the one that already
 * exists.
 *
 * A NAME IS A WEAKER PROXY THAN A GIT SHA — NAMED DELIBERATELY. Nothing stops a `claude agents --json` entry
 * from carrying `name: "review-1234"` (or `"fix-1234"`) for a reason that has nothing to do with working PR
 * #1234 (a person's own manually-named debug session, for instance); that entry would now bind and could
 * suppress a real dispatch. This repo does not treat `claude agents --json` as adversarial input — it reflects
 * genuinely running local processes, and forging an entry in it already requires local code execution — so the
 * trade is accepted rather than defended against here.
 *
 * Both paths' hits are unioned into one bound list, keyed by AGENT OBJECT IDENTITY in the `Map` below (so a
 * session that happens to satisfy both paths is stored once, not twice, with no separate dedup check needed —
 * a second `.set()` on the same key simply overwrites with the same value), and pass through the SAME liveness
 * assessment below — the union widens WHAT can bind, it does not change what a bind MEANS.
 * @param {{headRefOid?:string, number?:number|string}} pr
 * @param {Array<object>} agents
 * @returns {Array<{agent:object, cwd:string, sha:string}>}
 */
export function bindAgents(pr, agents, repo = 'we') {
  const sha = String(pr?.headRefOid ?? '');
  const list = Array.isArray(agents) ? agents : [];
  const bound = new Map();

  if (sha) {
    for (const a of list) {
      if (a && String(a.laneHeadOid ?? '') && String(a.laneHeadOid) === sha) {
        bound.set(a, { agent: a, cwd: String(a.cwd ?? ''), sha });
      }
    }
  }

  const prNumber = Number(pr?.number);
  if (Number.isInteger(prNumber) && prNumber > 0) {
    // #3438/#3967 — every name-based slug this pass can dispatch, unioned the same way path 1 and path 2
    // already are: a PR can legitimately have a live review, fix, OR ci-heal agent bound to it by name, and
    // this pass must refuse dispatching whichever kind is already running. `ci-heal` (multi-repo slice 7) reads
    // the SAME slug `we:scripts/operations/ci-heal-pr-dispatch.mjs#dispatchCiHeal` mints
    // (`sessionSlugFor(itemNum, 'ci-heal', pr, ...)`, which resolves to `pr` here exactly as `fix` already does
    // — see `sessionSlugFor`'s own `PR_KINDS` fallback), so a heal already in flight — dispatched by THIS pass
    // or by `planTick`'s own WE-only path — is never re-planned on the next tick.
    const slugs = [
      reviewSessionSlug(prNumber, repo),
      sessionSlugFor(prNumber, 'fix', null, '', repo),
      sessionSlugFor(prNumber, 'ci-heal', null, '', repo),
    ];
    for (const a of list) {
      if (a && slugs.includes(String(a.name ?? ''))) {
        bound.set(a, { agent: a, cwd: String(a.cwd ?? ''), sha });
      }
    }
  }

  return [...bound.values()];
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#isAwaitingPermission — the FIFTH state. `status: 'waiting'` with
 * `waitingFor` naming a permission prompt is neither alive nor dead: the process exists and will never advance,
 * because a background agent has nobody to ask. Three sessions have been in it for 211.4 hours. Pure.
 * @param {{status?:string, waitingFor?:string}} agent
 * @returns {boolean}
 */
export function isAwaitingPermission(agent) {
  return String(agent?.status ?? '').toLowerCase() === 'waiting'
    && /permission/i.test(String(agent?.waitingFor ?? ''));
}

/** How long after a review/fix session reports `blocked-on-infra` before it counts as finished, so the PR is
 *  retried. Long enough that a persistent outage (a spent rate limit, GitHub down) is not hammered by a fresh
 *  agent every two-minute tick; short enough that a recovered outage is retried within one coffee. */
export const INFRA_RETRY_COOLOFF_MS = 15 * 60 * 1000;

/**
 * we:scripts/conveyor/reconcile-core.mjs#markSelfReportedDone — mark each listed session that has REPORTED its
 * own completion. Pure (the record lookup is injected).
 *
 * WHY (xpb0zyq, live 2026-09-23). When the GitHub rate limit ran out, every dispatched review ended by writing
 * its completion record (`status: done`, `outcome: blocked-on-infra`), yet `claude agents` kept listing those
 * sessions as `blocked`. {@link assessLiveness} only trusted `state: 'done'`, so each PR stayed bound to a
 * reviewer that had already quit: the review daemon reported 0 owed on every tick and six PRs never retried,
 * even after the rate limit was fixed.
 *
 * A session counts as finished when its name's record says `done` AND was updated at or after the session
 * started. Records are keyed by session NAME and a name is reused for every re-dispatch, so the timestamp is
 * what keeps a fresh run from being read as the old one's completion. A `blocked-on-infra` outcome counts only
 * after {@link INFRA_RETRY_COOLOFF_MS}.
 * @param {Array<object>} agents - the `claude agents --json` rows
 * @param {(name:string)=>({status?:string, outcome?:string, updatedAt?:string}|null)} completionFor
 * @param {number} nowMs
 * @returns {Array<object>} the same rows; finished ones gain `selfReportedDone: true` and `selfReportedOutcome`
 */
export function markSelfReportedDone(agents, completionFor, nowMs) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    const name = a?.name;
    if (!name || String(a?.state ?? '').toLowerCase() === 'done') return a;
    let rec = null;
    try { rec = completionFor(String(name)); } catch { rec = null; }
    if (!rec || rec.status !== 'done') return a;
    const updatedMs = Date.parse(rec.updatedAt ?? '');
    const startedMs = startedAtMs(a?.startedAt);
    if (!Number.isFinite(updatedMs) || !Number.isFinite(startedMs) || updatedMs < startedMs) return a;
    if (rec.outcome === 'blocked-on-infra' && !(nowMs - updatedMs >= INFRA_RETRY_COOLOFF_MS)) return a;
    return { ...a, selfReportedDone: true, selfReportedOutcome: rec.outcome ?? null };
  });
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#assessLiveness — the liveness verdict for ONE PR, over the sessions
 * bound to it. Pure, and it is refusal 4 in code.
 *
 * ORDER IS THE SAFETY PROPERTY, worst-first, and it is not the order that reads most naturally:
 *   1. `awaiting-permission` OUTRANKS a live pid. Those three sessions have live pids; reporting them as merely
 *      "busy" is how a 211-hour block stays invisible. The distinct kind is the whole point.
 *   2. `live-process` — a bound session with a probed-live pid. Something IS working this PR; do not pile on.
 *   3. `liveness-unknown` — bound, but the `pid` is absent (4 of 17 entries carry none) or was not probed.
 *      Absence of a field is never evidence of death, so this REFUSES. It does not read as idle. A session
 *      confirmed stuck by other means (the GH #77683 zombie bug — `claude stop`/`claude rm` fail or no-op) is
 *      cleared via `we:scripts/operations/clear-stuck-session.mjs`, never by hand-moving its job directory or
 *      re-deriving a second liveness check.
 *   4. Only when every bound session is probed DEAD (`pidAlive === false`) does this return `null`, meaning
 *      "nothing live here, the caller may dispatch".
 *
 * `transcriptMtimeMs` is not consulted anywhere in this function, ON PURPOSE. A transcript stops being written
 * when an agent finishes exactly as when it dies, so freshness cannot grant liveness and staleness cannot
 * withdraw it. It rides along as evidence only.
 *
 * A session reporting `state: 'done'` is filtered out BEFORE any of the four ranks above, regardless of
 * `pidAlive` (live-caught #xq7g45m, PR #2461, 2026-09-22): in this environment a finished background agent's OS
 * process is recycled into a warm bg-spare pool rather than exiting, so `pidAlive` stays `true` forever after
 * the actual work on this PR is long done — the pid didn't die, it was just handed to unrelated later work. A
 * raw pid probe is only a stand-in for a session that has NOT reported its own terminal state; once an agent
 * says `done`, that is authoritative and a live pid proves nothing about THIS PR anymore.
 *
 * The same holds for a session whose OWN completion record says done ({@link markSelfReportedDone} sets
 * `selfReportedDone`), even when the listing still reads `blocked` (xpb0zyq, live 2026-09-23).
 * @param {Array<{agent:object, cwd:string, sha:string}>} bound
 * @returns {{kind:string, pid:number|null, cwd:string, sha:string, sessionId:string|null, why:string}|null}
 */
export function assessLiveness(bound) {
  const isFinished = (agent) => String(agent?.state ?? '').toLowerCase() === 'done' || agent?.selfReportedDone === true;
  const list = (Array.isArray(bound) ? bound : []).filter((b) => !isFinished(b.agent));
  const ev = (b, kind, why) => ({
    kind,
    pid: Number.isInteger(b.agent?.pid) ? b.agent.pid : null,
    cwd: b.cwd,
    sha: b.sha,
    sessionId: b.agent?.sessionId ?? null,
    why,
  });

  for (const b of list) {
    if (isAwaitingPermission(b.agent)) {
      return {
        ...ev(b, 'awaiting-permission', `session is blocked on "${String(b.agent.waitingFor)}" — a background agent has nobody to ask, so it will never advance on its own`),
        startedAt: b.agent?.startedAt ?? null,
        waitingFor: String(b.agent.waitingFor),
      };
    }
  }
  for (const b of list) {
    if (b.agent?.pidAlive === true) {
      return ev(b, 'live-process', 'a bound session has a LIVE pid — something is already working this PR, however stale its transcript looks');
    }
  }
  for (const b of list) {
    if (b.agent?.pidAlive !== false) {
      return ev(b, 'liveness-unknown', 'a session is bound to this PR but its liveness could not be established (no `pid` on the listing, or the probe did not run) — absence of a field is not evidence of death');
    }
  }
  return null;
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#planReconcile — THE PASS. Given every open PR, every live session, and
 * the durable per-PR attempt counts, return what to dispatch and every refusal with the fact it turned on. Pure,
 * total, and keyed by PR number throughout.
 *
 * EVERY PR YIELDS EXACTLY ONE ROW — a dispatch or a refusal, never neither. Silence is the defect this pass
 * exists to remove, so it is not allowed to reappear in this pass's own output.
 *
 * THE ORDER OF THE CHECKS, and why each sits where it does:
 *   1. `stood-down` FIRST, because it is terminal. Nothing that follows can revive a PR a fixer walked away
 *      from, so nothing that follows should even be computed.
 *   2. LIVENESS SECOND. If something is already working this PR, no further question is worth asking — and
 *      asking anyway is how two agents end up in one lane.
 *   3. PHASE, borrowed from `classifyPr`. What is owed, and by whom.
 *   4. FINDINGS, before the cap: a PR with nothing to fix gets a review or nothing, never a fixer, whatever its
 *      attempt count says.
 *   5. THE CAP, from the PR and only from the PR.
 *
 * @param {object} o
 * @param {Array<object>} [o.prs] - open PRs as `gh pr list --json number,headRefName,headRefOid,baseRefName,
 *   labels,statusCheckRollup,mergeStateStatus,comments` returns them, each optionally carrying `transcriptMtimeMs`
 *   (EVIDENCE ONLY — no decision reads it). `baseRefName` is what the STACKED-BASE CONFLICT branch keys on
 *   (#3383); its absence just means every `conflicted` PR falls through to the pre-#3383 `owed-elsewhere` path.
 * @param {Array<object>} [o.agents] - `claude agents --json` entries, each optionally carrying the two facts the
 *   listing cannot supply and the IO shell resolves: `laneHeadOid` (the `HEAD` of the lane at `cwd`) and
 *   `pidAlive` (`process.kill(pid, 0)` → `true`/`false`; absent = not probed = UNKNOWN).
 * @param {object} [o.durableCounts] - `{ [prNumber]: n }`, the PR-derived attempt count the shell reads back
 *   with `countRearmComments`. There is NO in-process tally parameter and none is consulted: a cap that a
 *   restart can reset is not a cap.
 * @param {number} [o.now] - epoch ms, used ONLY to age the surfaced permission-block notes. No decision reads it,
 *   so the plan for a given input is stable over time — a `stood-down` PR returns an identical result a week on.
 * @param {number} [o.roundCap] - the attempt cap; defaults to `NEGOTIATION_ROUND_CAP` (5), single-sourced from
 *   `we:scripts/lib/jury-core.mjs` rather than re-declared here.
 * @param {number} [o.ciHealCap] - the `ci-red` attempt cap (multi-repo slice 7); defaults to
 *   {@link CI_HEAL_ROUND_CAP} (3). Deliberately its OWN cap, not `roundCap`: a CI-heal round and a fix/review
 *   negotiation round are different work (a rebase-and-repair vs. a finding-and-fix), so binding them to one
 *   shared counter would let a PR burn through one cap doing the other kind of work.
 * @param {number} [o.conflictFixCap] - the mechanical conflict-resolution attempt cap (#xkmu3gv); defaults to
 *   {@link CONFLICT_FIX_ROUND_CAP} (3). See that constant's own docblock for why it is separate from `roundCap`.
 * @param {number} [o.advisoryFixCap] - the advisory-fix attempt cap on a `needs-human` PR (#xkmu3gv); defaults
 *   to {@link ADVISORY_FIX_ROUND_CAP} (3). See that constant's own docblock for why it is separate from
 *   `roundCap`.
 * @param {string} [o.defaultBranch] - the repo's default branch (#3383); defaults to `'main'`. A `conflicted`
 *   PR whose `baseRefName` differs from this is STACKED (built on another lane/PR) — see the STACKED-BASE
 *   CONFLICT branch below for why that population needs its own dispatch rather than the generic
 *   `owed-elsewhere` refusal.
 * @returns {{dispatch:Array<object>, refusals:Array<object>, notes:Array<object>}}
 */
export function planReconcile({
  repo = 'we', prs = [], agents = [], durableCounts = {}, now = 0, roundCap = NEGOTIATION_ROUND_CAP, ciHealCap = CI_HEAL_ROUND_CAP,
  conflictFixCap = CONFLICT_FIX_ROUND_CAP, advisoryFixCap = ADVISORY_FIX_ROUND_CAP, defaultBranch = 'main',
} = {}) {
  const dispatch = [];
  const refusals = [];
  const notes = [];
  const counts = durableCounts && typeof durableCounts === 'object' ? durableCounts : {};

  for (const pr of Array.isArray(prs) ? prs : []) {
    const prNumber = Number(pr?.number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue; // not a PR record; nothing to key on.

    // The evidence every row carries, so a reader never has to go back to the listing to audit a verdict.
    const base = {
      prNumber,
      headRefName: pr?.headRefName ?? null,
      headRefOid: pr?.headRefOid ?? null,
      // #3383 — carried on every row (evidence, mirrors `transcriptMtimeMs`/`body` just below): the STACKED-BASE
      // CONFLICT branch reads it, and a reader auditing any other row can see at a glance whether this PR is
      // stacked on another lane/PR at all, with no need to go back to the raw listing.
      baseRefName: pr?.baseRefName ?? null,
      // EVIDENCE ONLY. No decision in this file reads it — see the liveness block in the file docblock.
      transcriptMtimeMs: Number.isFinite(pr?.transcriptMtimeMs) ? pr.transcriptMtimeMs : null,
      // #xu2krte Fork 1 — carried on every row (not just `fix` dispatches) for the same "evidence travels with
      // the row" reason `transcriptMtimeMs` does. `reconcile-fix-dispatch.mjs` reads the `authored-by-actor`
      // stamp off it, ONLY for a `fix` dispatch that also carries the `merge-status:conflicting` label.
      body: typeof pr?.body === 'string' ? pr.body : null,
    };
    const refuse = (kind, extra) => { refusals.push({ ...base, kind, ...extra }); };

    // ── REFUSAL 1 — `stood-down` is TERMINAL. No decay, no clock: `now` is not read on this path, so the same
    // PR returns the same refusal a week later. A person clearing the marker is the intended exit.
    //
    // `countTerminalStandDowns`, NOT the raw `countStandDownComments` — #xu2krte Fork 2 (review-human statute
    // amendment). It excludes ONLY a parked-PR conflict watch stand-down that the watch ITSELF later superseded,
    // with both comments self-authored (GitHub's `viewerDidAuthor`, not a body substring anyone could forge) —
    // `we:scripts/conveyor/stand-down.mjs#isStandDownSuperseded`. A watcher stand-down that was never superseded
    // is current and stays terminal. A fix agent's OWN needs-judgment/gate-red/lane-ref-gone escalation, or a
    // human's `/finish` stand-down, is never excluded.
    const stoodDown = countTerminalStandDowns(pr?.comments);
    if (stoodDown > 0) {
      refuse('stood-down', {
        standDowns: stoodDown,
        why: 'a fix agent already stopped here to ask a question — re-dispatching would re-ask it forever. Terminal for this pass; a human clears the marker.',
      });
      continue;
    }

    // ── REFUSAL 4 — liveness, from a live process. The binding is derived and its evidence travels with the
    // refusal, because the derivation itself has been observed to be wrong (#3283).
    const live = assessLiveness(bindAgents(pr, agents, repo));
    if (live) {
      refuse(live.kind, {
        pid: live.pid, cwd: live.cwd, sha: live.sha, sessionId: live.sessionId, why: live.why,
        ...(live.waitingFor ? { waitingFor: live.waitingFor, startedAt: live.startedAt } : {}),
      });
      // The permission block is the case that must never be merely refused. Three sessions have held one for
      // 211.4 hours; a refusal buried in a list is how that stayed invisible. It gets its own surfaced note.
      if (live.kind === 'awaiting-permission') {
        const startedMs = startedAtMs(live.startedAt);
        const heldHours = Number.isFinite(startedMs) && now ? Math.round(((now - startedMs) / 3_600_000) * 10) / 10 : null;
        notes.push({
          kind: 'awaiting-permission', prNumber, pid: live.pid, cwd: live.cwd, sessionId: live.sessionId,
          waitingFor: live.waitingFor, startedAt: live.startedAt, heldHours,
          text: `PR #${prNumber}: a session in ${live.cwd} is blocked on "${live.waitingFor}"`
            + `${heldHours == null ? '' : ` for ${heldHours}h`} and nobody is there to answer it — nothing here will advance until a person clears it`,
        });
      }
      continue;
    }

    // ── PHASE, BORROWED. `classifyPr` for the labels, `reduceCheckState` for CI truth. Not re-derived.
    const phase = classifyPr({
      state: pr?.state, labels: pr?.labels, mergeStateStatus: pr?.mergeStateStatus,
      statusCheckRollup: pr?.statusCheckRollup,
    });
    const check = reduceCheckState(pr?.statusCheckRollup);
    const withPhase = { phase, check: check.state, labels: labelNames(pr?.labels) };

    // ── `ci-red` (multi-repo slice 7) — its OWN branch, ahead of the generic `OWED`/`OWED_ELSEWHERE` table,
    // because it needs neither of that table's two remaining checks: REFUSAL 2 ("no findings, no fixer") does
    // not apply — a red required check IS the finding, there is no reviewer thread to count — and the cap is
    // its OWN durable floor ({@link countCiHealComments}, one marker comment per completed heal, #2666), never
    // `roundCap`'s rearm/advisory counters (see {@link CI_HEAL_ROUND_CAP}'s own docblock for why the two caps
    // stay separate). Capability (does THIS repo's profile allow a CI-heal at all?) is deliberately NOT checked
    // here, for the same reason `fix` is never capability-checked in this file either: this pass decides what
    // is owed from the PR alone, and leaves "can this repo's worker actually do it" to the dispatcher that
    // reads this plan (`we:scripts/operations/ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch`, mirroring
    // `reconcile-fix-dispatch.mjs#runReconcileFixDispatch`'s own capability gate for `fix`).
    if (phase === 'ci-red') {
      const ciHealAttempts = countCiHealComments(pr?.comments);
      if (ciHealAttempts >= ciHealCap) {
        refuse('cap-exhausted', {
          ...withPhase, attempts: ciHealAttempts, cap: ciHealCap,
          why: `the PR's own durable CI-heal count is ${ciHealAttempts} against a cap of ${ciHealCap} — auto-heal is exhausted here and a person must take it`,
        });
      } else {
        dispatch.push({
          ...base, ...withPhase, kind: 'ci-heal', attempts: ciHealAttempts,
          why: `a required check is failing, nothing live is working it, and ${ciHealAttempts} of ${ciHealCap} CI-heal attempts are spent`,
        });
      }
      continue;
    }

    // ── ADVISORY-FIX (#xkmu3gv) — its OWN branch, ahead of the generic `OWED` table, the same way `ci-red` sits
    // ahead of it above. A `needs-human` PR carrying an admitted `advisory:changes` finding that has NOT yet
    // been fixed for the CURRENT advisory note (its own durable advisory-fix count < the advisory-note count)
    // owes a FIX here, never the `review` the generic table would otherwise dispatch for this phase — a fresh
    // review before the finding is even addressed would just re-run `advise` against the same broken head and
    // repost the identical finding. Once a fix round completes (the count catches up), this branch falls
    // through to the ordinary `needs-human` → `review` path below, which re-runs `advise` and posts the next
    // real verdict on the repaired head. Gated on `phase === 'needs-human'` specifically — a `bounced` PR (real
    // `review:changes` present, phase 'bounced' wins in `classifyPr`) is handled by the conflict-fix carve-out
    // inside the generic cap step below, never here; the two populations are mutually exclusive by phase.
    if (phase === 'needs-human' && withPhase.labels.includes(ADVISORY_LABELS.CHANGES)) {
      const advisoryNotes = countAdvisoryComments(pr?.comments);
      const advisoryFixes = countAdvisoryFixComments(pr?.comments);
      if (advisoryFixes < advisoryNotes) {
        // REFUSAL 2, narrowed to this population: `advisory:changes` implies a posted advisory note, which IS a
        // real finding — countFindings should never read 0 here, but this is named rather than silently
        // falling through to the generic `no-findings` branch below (which is keyed to `OWED[phase] ===
        // 'review'` only and would never dispatch a fix for a zero-finding PR).
        const advisoryFindingsHere = countFindings(pr?.comments);
        if (advisoryFindingsHere === 0) {
          refuse('no-findings', {
            ...withPhase, findings: 0, comments: Array.isArray(pr?.comments) ? pr.comments.length : 0,
            why: 'labelled advisory:changes but no admitted finding is on the thread — refusing to invent one',
          });
          continue;
        }
        if (advisoryFixes >= advisoryFixCap) {
          refuse('cap-exhausted', {
            ...withPhase, attempts: advisoryFixes, cap: advisoryFixCap, capKind: 'advisory-fix',
            why: `this PR's own durable advisory-fix count is ${advisoryFixes} against a cap of ${advisoryFixCap}` +
              ' — auto-repair of the advisory finding is exhausted here and a person must take it',
          });
          continue;
        }
        dispatch.push({
          ...base, ...withPhase, kind: 'fix', mode: 'advisory-fix', findings: advisoryFindingsHere,
          attempts: advisoryFixes, cap: advisoryFixCap,
          why: `carries an admitted advisory:changes finding, ${advisoryFixes} of ${advisoryFixCap} advisory-fix` +
            ' attempts are spent, and nothing live is working it — the fixer addresses the advisory finding' +
            ' only, never review:human, never a verdict',
        });
        continue;
      }
      // else: already fixed for the CURRENT advisory note (advisoryFixes >= advisoryNotes) — fall through to
      // the ordinary `OWED['needs-human'] = 'review'` path below, unchanged.
    }

    // ── STACKED-BASE CONFLICT (#3383) — its OWN branch, ahead of the generic `OWED`/`OWED_ELSEWHERE` table, for
    // the ONE `conflicted`-phase population that table's blanket "owed-elsewhere: the branch needs a rebase
    // before it can merge" answer describes a rebase NOBODY will ever perform. A PR whose `baseRefName` is not
    // `defaultBranch` is STACKED (built on another lane/PR, per `#poc-branch-declared-delivery-mode` clause 5:
    // "base is not <default>") — the drain will never land it regardless of label, so `OWED_ELSEWHERE.conflicted`
    // naming "a rebase… owed to the drain" is simply wrong for this population: nobody is coming.
    // `we:scripts/conveyor/parked-pr-conflict-watch.mjs`'s own queued-conflict grace path independently defers to
    // THIS branch for the identical reason (see that file's own `graceDue` block) rather than bouncing it via
    // `postFinding`, which would strip `review:accepted` and force a fresh human review for what is ordinarily a
    // purely mechanical rebase against the PR's OWN base — never a real reviewer-facing content conflict.
    //
    // CONFIRMED LIVE 2026-09-24: `chalbert/web-everything#2578` (`review:accepted`, base
    // `lane/3681-ratify-daemon-lifecycle`, stacked on PR #2549) went `owed-elsewhere` here and unreported by
    // `parked-pr-conflict-watch.mjs sweep --dry-run` alike, after a fixer pushed to its base — a genuine
    // stacked-PR gap no daemon closed. See `reconcile-core.test.mjs` for the pinned regression.
    //
    // BOUND ON THE SAME DURABLE MARKER/CAP `#xkmu3gv` (PR #2579) ADDED FOR THE MECHANICAL MAIN-BASE CONFLICT-FIX
    // POPULATION ({@link CONFLICT_FIX_ROUND_CAP}, `countConflictFixComments`) — this is the identical KIND of
    // work (rebase-and-resolve, never a judgment call over a reviewer's finding), just against a different ref,
    // so it shares that population's floor rather than inventing a third one. `mode: 'stacked-rebase'` and
    // `baseRefName` ride on the dispatch row so `we:skills-src/conveyor/fix-agent-brief.md`'s own STACKED-BASE
    // MODE section, and any reader, can see at a glance which ref this repair merges — the brief re-reads it LIVE
    // off the PR itself before acting, never trusting a stale value here, so a PR GitHub has since retargeted to
    // `defaultBranch` (its stacked base merged to `main` and was deleted — the ordinary, expected path) is read
    // correctly at repair time even if this row was planned a tick earlier against the old base.
    //
    // The hand-back posts the SAME `CONFLICT_FIX_COMMENT_MARKER` `rearm-review.mjs --round=conflict` posts
    // (`scripts/conveyor/conflict-fix-mark.mjs`), but touches NO label at all — unlike the ordinary conflict-fix
    // round, this PR was never bounced to `review:changes` in the first place, so there is nothing to "re-arm";
    // `review:accepted` (or whatever it already carried) rides through this repair completely untouched.
    //
    // NEVER FIRES for `baseRefName === defaultBranch` (including a `null`/unknown base) — that population falls
    // straight through, unchanged, to the existing `OWED_ELSEWHERE.conflicted` refusal below, exactly as it did
    // before this branch existed. It also never fires for any OTHER phase — a stacked PR that is `bounced`,
    // `needs-human`, etc. is handled entirely by that phase's own existing branch, unaffected by this one.
    if (phase === 'conflicted') {
      const baseRefName = pr?.baseRefName ?? null;
      const isStackedBase = Boolean(baseRefName) && baseRefName !== defaultBranch;
      if (isStackedBase) {
        const conflictAttempts = countConflictFixComments(pr?.comments);
        if (conflictAttempts >= conflictFixCap) {
          refuse('cap-exhausted', {
            ...withPhase, attempts: conflictAttempts, cap: conflictFixCap, capKind: 'conflict-fix',
            why: `this PR's own durable conflict-fix count is ${conflictAttempts} against a cap of ${conflictFixCap}` +
              ` — mechanical rebase against its base \`${baseRefName}\` is exhausted here and a person must take it`,
          });
        } else {
          dispatch.push({
            ...base, ...withPhase, kind: 'fix', isConflict: true, mode: 'stacked-rebase', baseRefName,
            attempts: conflictAttempts, cap: conflictFixCap,
            why: `conflicts with its own base \`${baseRefName}\` (not \`${defaultBranch}\`) — a stacked PR the ` +
              'drain will never land regardless of labels, so this is a mechanical rebase against its base, ' +
              `never a rebase owed to the drain; ${conflictAttempts} of ${conflictFixCap} conflict-fix attempts are spent`,
          });
        }
        continue;
      }
    }

    if (!OWED[phase]) {
      if (OWED_ELSEWHERE[phase]) refuse('owed-elsewhere', { ...withPhase, why: OWED_ELSEWHERE[phase] });
      else refuse('nothing-owed', { ...withPhase, why: `phase \`${phase}\` — reviewed and queued, or already landed; this pass has nothing to dispatch` });
      continue;
    }

    // ── REFUSAL 2 — no findings, no fixer. A fix agent handed a PR with nothing to fix invents work. When a
    // review is what the phase asks for, the review still goes out: "nothing to FIX" is not "nothing to do".
    const findings = countFindings(pr?.comments);
    if (findings === 0) {
      refuse('no-findings', {
        ...withPhase, findings: 0, comments: Array.isArray(pr?.comments) ? pr.comments.length : 0,
        why: 'no reviewer finding on this PR — a fix agent would invent work. A review, not a fix, is what an unreviewed PR is owed.',
      });
      if (OWED[phase] === 'review') {
        dispatch.push({ ...base, ...withPhase, kind: 'review', findings: 0, attempts: 0, why: 'parked for an independent review and no finding has been raised yet — a review is owed (#3279 runs it)' });
      }
      continue;
    }

    // ── CONFLICT-FIX (#xkmu3gv) — a `bounced` PR that ALSO carries `merge-status:conflicting` is the mechanical
    // conflict-resolution population `we:scripts/conveyor/reconcile-fix-dispatch.mjs`'s own `isConflict` flag
    // already identifies (`origin/lane/xdhidso-review-human-statute-fixer`, PR #2577's routing rule). It binds
    // on its OWN, smaller cap ({@link CONFLICT_FIX_ROUND_CAP}), counted from its OWN marker
    // (`countConflictFixComments`) — NEVER the shared `roundCap`/`countRearmComments`/`countAdvisoryComments`
    // floor below, which a PR can independently have already exhausted on real review negotiation (CONFIRMED
    // LIVE: `chalbert/web-everything#2549`, `review-round:5` against the shared cap of 5, zero conflict-fix
    // rounds ever run). See that constant's own docblock for the full incident.
    const isConflictBounce = phase === 'bounced' && withPhase.labels.includes(CONFLICT_LABEL);
    if (isConflictBounce) {
      const conflictAttempts = countConflictFixComments(pr?.comments);
      if (conflictAttempts >= conflictFixCap) {
        refuse('cap-exhausted', {
          ...withPhase, attempts: conflictAttempts, cap: conflictFixCap, capKind: 'conflict-fix',
          why: `this PR's own durable conflict-fix count is ${conflictAttempts} against a cap of ${conflictFixCap}` +
            ' — mechanical conflict-resolution is exhausted here and a person must take it',
        });
        continue;
      }
      // A conflict-labelled bounce may ALSO carry an admitted `advisory:changes` finding (both routes can be
      // true of the same PR at once, e.g. `#2549`) — named on the dispatch row rather than silently dropped, so
      // a reader sees BOTH facts even though only the conflict fix is owed on THIS row (the advisory-fix branch
      // above owns dispatching the advisory repair itself, once this bounce clears and the phase reverts to
      // `needs-human`).
      const advisoryAlsoPending = withPhase.labels.includes(ADVISORY_LABELS.CHANGES);
      dispatch.push({
        ...base, ...withPhase, kind: 'fix', isConflict: true, advisoryPending: advisoryAlsoPending,
        findings, attempts: conflictAttempts, cap: conflictFixCap,
        why: `bounced with ${findings} finding(s) via a mechanical conflict-resolution route (merge-status:conflicting),`
          + ` nothing live is working it, and ${conflictAttempts} of ${conflictFixCap} conflict-fix attempts are spent`
          + (advisoryAlsoPending
            ? ' — this PR also carries an admitted advisory:changes finding, owed its own advisory-fix round once this conflict clears'
            : ''),
      });
      continue;
    }

    // ── REFUSAL 3 — the cap, from the PR and ONLY from the PR. `durableCounts` is what the shell read back off
    // the PR's comment thread; `countRearmComments` re-reads the same thread here so a shell that forgot to
    // supply the map cannot silently reset a burned PR to zero. NO in-process tally is consulted, by design:
    // this pass is one-shot, it carries nothing in, and a cap a restart can reset is not a cap.
    //
    // #3383 — `countAdvisoryComments` is UNIONED IN, not swapped for `countRearmComments`. A `bounced` PR that
    // ALSO carries `review:human` can run round after round without ever completing a repair-and-rearm cycle
    // (the fix keeps failing/stalling), so `countRearmComments` alone can stay pinned at 0 forever even though
    // real rounds are running — confirmed live on `#2117` (33 advisory comments against the identical findings
    // between 2026-09-15T00:24Z and 19:13Z, roughly every 20-90 minutes, no end condition) and `#2298`. What DOES
    // post once per completed round for that population is the automatic advisory-panel comment
    // (`we:scripts/operations/review-pr.mjs`'s `advise` step, #xlw02hw) — counting THAT recovers the real round
    // count. Kept as a `Math.max` alongside the rearm count, never a replacement: a PR can carry BOTH kinds of
    // history, and the cap must bind on whichever count is higher, never reset by reading only one of the two.
    const attempts = Math.max(
      Number(counts[prNumber]) || 0,
      countRearmComments(pr?.comments),
      countAdvisoryComments(pr?.comments),
    );
    if (attempts >= roundCap) {
      refuse('cap-exhausted', {
        ...withPhase, attempts, cap: roundCap,
        why: `the PR's own durable attempt count is ${attempts} against a cap of ${roundCap} — auto-repair is exhausted here and a person must take it`,
      });
      continue;
    }

    dispatch.push({
      ...base, ...withPhase, kind: OWED[phase], findings, attempts,
      why: OWED[phase] === 'fix'
        ? `bounced with ${findings} finding(s), nothing live is working it, and ${attempts} of ${roundCap} attempts are spent`
        : `parked for an independent review with ${findings} finding(s) on the thread and nothing live working it`,
    });
  }

  return { dispatch, refusals, notes };
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#selectStatusCandidates — PURE: which PRs deserve an informative
 * `review-status:*` refresh (`we:scripts/conveyor/review-status-tag.mjs`) this tick, given this pass's own
 * `dispatch`/`refusals` output.
 *
 * EVERY PR THIS PASS HAS AN OPINION ABOUT, EXCEPT `nothing-owed`. `nothing-owed` is the ONLY refusal kind that
 * genuinely means "reviewed and queued, already landed, or a signal-free PR unrelated to this loop" — see
 * {@link OWED_ELSEWHERE}. `owed-elsewhere` does NOT mean that: it fires for a `needs-human`/`conflicted` phase
 * alike (`ci-red` moved OFF this table at multi-repo slice 7 — it is a real `dispatch` entry, `kind:'ci-heal'`,
 * now, not a refusal), which are real conveyor-dispatched PRs stuck on something this pass does not run (a
 * human clear, a rebase) — NOT unrelated PRs. Before this function existed,
 * `we:skills-src/conveyor/runner.mjs`'s own inline filter excluded `owed-elsewhere` wholesale on the mistaken
 * premise that it "covers every unrelated human PR" — confirmed live 2026-09-05 on PR #1920: its `needs-human`
 * refusal (kind `owed-elsewhere`) was excluded from every tick's refresh sweep, so its stale
 * `review-status:reviewing` label — left over from a session that no longer exists in `claude agents --json`
 * at all — was NEVER re-derived and cleared. `review-status-tag.mjs` is idempotent and name-keyed (matches
 * `review-<pr>`/`fix-<pr>` sessions fresh each call), so calling it on a PR with nothing live simply clears any
 * stale label — safe to call on every candidate this returns, including a genuinely-foreign PR that happens to
 * reach `owed-elsewhere` (a wasted `gh`/`claude agents` read at worst, never a wrong label).
 * SAME BUG CLASS, THIRD TIME (live-caught 2026-09-22, PR #2472): a PR that moves to being owed a FIX
 * (`plan.dispatch`'s `kind:'fix'` entries — e.g. a `review:changes` bounce) used to be in NEITHER
 * `reviewsOwed` NOR `refusals`, so its status label never got re-derived once it left the review-owed
 * state. PR #2472's own `review-2472` session finished and posted its real `review:changes` verdict, but
 * `review-status:reviewing` sat stale on the PR for ~2 hours — nothing ever called `review-status-tag.mjs`
 * for it again to notice the session was `done` and clear the label. Exactly the same root shape as the
 * `owed-elsewhere` miss documented above (a real, currently-relevant PR silently excluded from the refresh
 * sweep), just a different exclusion. Fixed by adding `fixesOwed` as a THIRD candidate source, included the
 * same unconditional way `reviewsOwed` already is — `review-status-tag.mjs` stays idempotent and
 * name-keyed, so including a fix-owed PR here costs one wasted read at worst on a genuinely quiet PR, never
 * a wrong label.
 * @param {Array<{prNumber:number}>} reviewsOwed - the `kind:'review'` subset of this pass's own `dispatch`
 * @param {Array<{kind:string, prNumber:number}>} refusals - this pass's own `refusals`
 * @param {Array<{prNumber:number}>} [fixesOwed] - the `kind:'fix'` subset of this pass's own `dispatch`
 * @returns {Array<{prNumber:number}>} reviewsOwed + fixesOwed, plus every refusal except `nothing-owed`
 */
export function selectStatusCandidates(reviewsOwed, refusals, fixesOwed) {
  return [
    ...(Array.isArray(reviewsOwed) ? reviewsOwed : []),
    ...(Array.isArray(fixesOwed) ? fixesOwed : []),
    ...(Array.isArray(refusals) ? refusals : []).filter((r) => r && r.kind !== 'nothing-owed'),
  ];
}
