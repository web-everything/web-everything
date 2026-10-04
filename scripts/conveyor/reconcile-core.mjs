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
import { isAiGeneratedPr } from '../lib/ai-pr-authorship.mjs';
import { reviewCiGate } from '../lib/review-ci-gate.mjs';
import { REFERRAL_HOLD_MARKER } from './review-referral-hold.mjs';
import { OPERATOR_ANSWER_MARKER, isOperatorAnswerStandDownSuperseded, latestOperatorAnswer, answerDisposition } from './stand-down-answer-core.mjs';
import { classifyPr } from '../progress-board.mjs';
import { reduceCheckState } from '../operations/pr-status.mjs';
import { isForeignCompletionSessionId } from '../operations/completion-record.mjs';
import { NEGOTIATION_ROUND_CAP } from '../lib/jury-core.mjs';
import { countRearmComments, REARM_COMMENT_MARKER } from './rearm-review.mjs';
// #3383 — see this module's own REFUSAL 3 note below, and `advisory-round-count.mjs`'s header for the
// `#2117`/`#2298` incident this closes.
import { countAdvisoryComments, ADVISORY_NOTE_MARKER } from './advisory-round-count.mjs';
import { countCiHealComments, CI_HEAL_COMMENT_MARKER } from './ci-heal-mark.mjs';
import { latestCiHealEscalationForHead, CI_HEAL_ESCALATION_MARKER } from './ci-heal-escalation-mark.mjs';
import {
  isStandDownSuperseded, STAND_DOWN_MARKER, SUPERSEDE_STAND_DOWN_MARKER,
  CONCURRENT_AUTHOR_PAUSE_MARKER, concurrentAuthorPauses, isConcurrentAuthorStandDown,
} from './stand-down.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from './fix-procedure.mjs';
import { isOperatorAuthored, isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { reviewSessionSlug } from './review-session-slug.mjs';
// Both dispatcher wrappers delegate to the pure session-slug module.
import { sessionSlugFor } from '../operations/dispatch-lane.mjs';
// #xkmu3gv — two NEW, narrow populations, each with its OWN durable marker/cap (see each leaf's own header):
// a mechanical conflict-resolution round (routed by `origin/lane/xdhidso-review-human-statute-fixer`, PR #2577)
// and an advisory-fix round on a `needs-human` PR carrying `advisory:changes`. Both are true leaves — no fs, no
// clock, no process, no network — so importing them keeps this file PURE and leaf-light exactly as its own
// header requires.
import { countStaleConflictFixRounds, CONFLICT_FIX_COMMENT_MARKER } from './conflict-fix-round-count.mjs';
import {
  countCompletedAdvisoryEpisodes, ADVISORY_FIX_COMMENT_MARKER,
  isLatestAdvisoryFindingAddressed, isAdvisoryMechanismStandDownSuperseded,
} from './advisory-fix-mark.mjs';
import { CONFLICT_LABEL } from './conflict-label.mjs';
// advisory-after-cap (web-everything/web-everything#2766 live incident, 2026-09-27) — see the ADVISORY-FIX
// cap-exhausted branch below for why the "is a fresh review owed on a stale advisory note" check reuses these
// two, never a second reimplementation of "does the newest advisory comment name this PR's CURRENT head".
import { ADVISORY_LABELS, latestAdvisory, advisoryCoversHead } from '../lib/advisory-labels.mjs';
// we:backlog/x5uqim1-*.md (parent #4075, epic #3383) — LIVE INCIDENT 2026-09-25: a `ci-red` PR whose required
// check failed only because `origin/main`'s own CI was red at that moment must never be handed to `ci-heal`,
// which would "repair" code that was never broken. `isPrCiFailureOwedRerun` is the PURE leaf that decides this
// (see its own docblock for the full incident and the two facts it needs); this file only calls it.
import {
  isPrCiFailureOwedRerun, countRebaseOntoMainComments, DEFAULT_MAX_REBASE_RETRIES_PER_SHA,
  // landing-freeze fix (2026-09-27) — used only to word the `owed-ci-rerun` refusal's `why` accurately when
  // THIS path (not the red-window one) is what actually granted it; see that function's own docblock.
  classifyCiFailureAttribution,
} from './main-red-recovery.mjs';
// #2588/review-loops (epic #3383/#4075) — read-only reuse of the drain's OWN reviewed-sha marker (never a
// second derivation): `parseReviewedSha` recovers the head an ACCEPT-shaped verdict (`accepted`/`clear-human`/
// `restamp`) covered. See {@link planReconcile}'s ONE-REVIEW-PER-HEAD refusal for why this pass needs it too.
import {
  parseReviewedSha, planConvertSupersededVerdict, targetedCheckQuestion, findAcceptVerdictComment, REVIEW_LABELS,
} from '../lib/review-escalation.mjs';
// live incident, web-everything/web-everything PR #2752 (#4034/#2748) — a PR whose own content is ALREADY on `main`,
// carried there by a different PR that stacked on its branch and merged first, never owes a fix or a review.
// The verdict itself (`pr.alreadyLandedInMain`, per-file blob-identity evidence) is computed by the IO shell
// (`we:scripts/conveyor/reconcile-pass.mjs#enrichPrsWithAlreadyLandedFacts`, `we:scripts/lib/
// already-landed-content.mjs`); this file only reads the already-decided fact off the PR record, exactly like
// `requiredCheckCompletedAt`/`aheadByOnMain` above.

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
// #xconv1 (web-everything/web-everything#2766/#2767 unblock) — `convert-advisory` is the FOURTH kind: a `needs-human`
// PR whose CURRENT head already completed an independent jury review that a LATER escalation superseded (never
// a fresh push — see the ONE-REVIEW-PER-HEAD block below). It converts that verdict into the standing advisory
// note plus one targeted check on the escalation's own reason, instead of dispatching a whole second panel run
// (`kind:'review'`) at a head nobody has touched since — see {@link planConvertSupersededVerdict}.
// `promote-draft` (draft-first PRs, operator-approved 2026-09-27) — the FIFTH kind: a draft PR (opened by
// `scripts/pr-land.mjs --park`'s new draft-by-default open, see that flag's own docblock) whose required
// checks are ALL green. Nothing here spawns an agent for it — the effect is a bare `gh pr ready <pr>`
// (`scripts/operations/promote-draft-pr-dispatch.mjs`), which is what lets a review dispatch at all: a draft
// PR never reaches `kind:'review'` regardless of its label (see {@link dispatchReviewRow}'s own `isDraft`
// gate below), so the review this pass would otherwise dispatch the moment CI finishes is instead HELD until
// this fires and un-drafts it — closing the "6 of 26 PRs got reviewed before their own first CI run even
// finished" measurement (operator, 2026-09-27) that motivated this whole feature.
export const DISPATCH_KINDS = Object.freeze(['fix', 'review', 'ci-heal', 'ci-timeout-rerun', 'convert-advisory', 'promote-draft', 'restore-review-label', 'close-superseded']);

/**
 * we:scripts/conveyor/reconcile-core.mjs#REFUSAL_KINDS — every reason this pass declines to dispatch. Frozen and
 * exhaustive: a refusal that is not on this list is a bug, because a refusal this file cannot NAME is a refusal a
 * reader cannot audit.
 *
 *   `stood-down`         — a fixer already stopped to ask here (terminal; a person clears it).
 *   `no-findings`        — nothing to fix; a fixer would invent work.
 *   `cap-exhausted`      — the PR's own durable attempt count is at or above the cap. For the `ci-red` branch
 *                          specifically (#xznd5za), this ALSO surfaces a `kind:'ci-heal-exhausted'` note —
 *                          mirroring `awaiting-permission`'s own "refuses AND surfaces" treatment below — so a
 *                          capped, still-red required check is never merely one more line in the refusal list.
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
 *   `owed-ci-rerun`      — we:backlog/x5uqim1-*.md (#4075/#3383): the required check failed while `main`'s OWN
 *                          CI was red (`we:scripts/conveyor/main-red-recovery.mjs#isPrCiFailureOwedRerun`) and
 *                          this PR's head has not yet been refreshed onto the now-recovered `main`. Owed a
 *                          mechanical rebase onto `main` (`we:scripts/conveyor/ci-red-recovery-watch.mjs`, via
 *                          the SAME proven `we:scripts/lib/rebase-drop-manifest.mjs` plumbing the drain itself
 *                          uses), NEVER a `ci-heal` — a ci-heal agent dispatched here would misdiagnose `main`'s
 *                          own breakage as a defect in code that was never broken. NAMED `owed-ci-rerun` for the
 *                          population it covers (a red-`main`-caused CI failure), not the literal mechanism —
 *                          see the leaf's own file header for why a REBASE, not a rerun of the same stale
 *                          commit, is what actually resolves it. Once the head already contains `main`'s
 *                          current tip and is STILL red, this refusal no longer fires and the PR falls through
 *                          to the ordinary `ci-red` → `ci-heal` path below, unaffected. we:backlog/
 *                          review-while-main-red (#4075/#3383): this refusal NO LONGER means nothing else is
 *                          dispatched for the PR — a `review:pending` PR reaching it also gets a `review`
 *                          dispatched IN PARALLEL (`extra: { owedCiRerun: true }` on that row), via {@link
 *                          dispatchReviewRow}, since the rebase and the review are independent facts about the
 *                          PR. See that function's own docblock for the live incident (#2769/#2770/#2772/#2778/
 *                          #2779) this closes.
 *   `nothing-owed`       — the PR is reviewed and queued, or already landed. Genuinely nothing to do.
 *   `already-reviewed-head` — #2588/review-loops (epic #3383/#4075): the PR's CURRENT head already carries a
 *                          `reviewed-sha` accept marker (`we:scripts/lib/review-escalation.mjs#parseReviewedSha`).
 *                          A review already ran against this exact commit; dispatching another risks a second,
 *                          contradicting verdict landing on a commit nobody has touched since (the live #2588
 *                          incident this refusal closes: 3 review sessions in 16 minutes on one head, "changes"
 *                          then "accepted" 5 minutes apart). #xconv1 (web-everything/web-everything#2766/#2767
 *                          unblock) carved out ONE exception: a `needs-human` PR in this exact shape whose
 *                          comments also carry a LATER escalation (test-gaming/manifest-tamper park, or the
 *                          #2773 mutual-exclusivity heal) is not this risk at all — `review:human` already
 *                          forbids a second ACCEPT — so that shape dispatches `kind:'convert-advisory'` instead
 *                          of refusing here; see `planConvertSupersededVerdict` and {@link dispatchReviewRow}.
 *                          we:backlog/4352 carved out a SECOND: a `review:pending` head whose accept comment is
 *                          older than {@link ACCEPT_LABEL_GRACE_MS} lost its label write (budget-dropped), so it
 *                          dispatches the ordinary `review` (`relabelOwed: true`) — see {@link acceptLabelDropped}.
 *   `already-landed`    — live incident, web-everything/web-everything PR #2752 (#4034/#2748): every file this PR
 *                          touches is byte-identical to some commit already on `main` — its own content was
 *                          carried there by a DIFFERENT PR (often one stacked on its branch that merged first)
 *                          while THIS PR's ref was separately rebased and drifted into an apparent conflict.
 *                          Nothing is owed here — not a fix (there is nothing left to change), not a review
 *                          (there is nothing new to judge) — and dispatching a fix risks it "resolving" the
 *                          apparent conflict by reverting the carrier PR's later work. This PR should be closed
 *                          and its backlog card resolved, never dispatched; see
 *                          `we:scripts/conveyor/already-landed-watch.mjs` for the pass that acts on it.
 */
export const REFUSAL_KINDS = Object.freeze([
  'review-ci', 'review-referrals-pending',
  'stood-down', 'no-findings', 'cap-exhausted',
  'live-process', 'awaiting-permission', 'liveness-unknown',
  'owed-elsewhere', 'owed-ci-rerun', 'nothing-owed', 'already-reviewed-head', 'already-landed',
  // we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — a ci-heal already escalated THIS EXACT
  // head (`ci-heal-escalation-mark.mjs`); see that file's own header for the live incident (#2783, three
  // sessions in one evening). `ci-heal-escalated` — a genuine judgment call, terminal until a new push.
  // `waiting-on-system-fix` — the red is the tooling/gate's own fault and a system-level fix is already open
  // for it; this PR owes nothing further until that fix lands or its own head changes.
  'ci-heal-escalated', 'waiting-on-system-fix',
  // `draft` (draft-first PRs, operator-approved 2026-09-27) — the PR is still a GitHub draft: no review is
  // dispatched, whatever `review:*` label it carries, until the `promote-draft` DISPATCH_KIND (above) has
  // un-drafted it. See {@link dispatchReviewRow}'s own gate.
  'draft',
  // fix procedure (operator-approved 2026-09-27, live incident PR #2811) — `fix-claimed`: a fixer holds the PR's
  // live fix claim (`we:scripts/conveyor/fix-procedure.mjs`); NOTHING is dispatched for it (review, advisory,
  // fix, ci-heal, promote-draft) until `fix-end` or the claim's TTL. `concurrent-author-paused`: a fixer paused
  // because another author was pushing; NOT terminal — re-arms on the next head or after
  // {@link CONCURRENT_AUTHOR_QUIET_MS} of quiet.
  'fix-claimed', 'concurrent-author-paused',
]);

/**
 * we:scripts/conveyor/reconcile-core.mjs#CONCURRENT_AUTHOR_QUIET_MS — how long a PR's head must stay put after a
 * concurrent-author pause before the fix loop re-arms on that SAME head (the other author is done). A new head
 * re-arms at once. 20 minutes: longer than a typical push-fix-push burst, far shorter than "forever".
 */
export const CONCURRENT_AUTHOR_QUIET_MS = 20 * 60 * 1000;

/**
 * we:scripts/conveyor/reconcile-core.mjs#concurrentAuthorPauseState — is this PR still held by its latest
 * concurrent-author pause, or re-armed? PURE. `null` when the PR carries no pause at all.
 *   - held:     the head is the one the pause recorded (or the pause recorded none — a legacy stand-down) AND
 *               the pause is younger than `quietMs`.
 *   - re-armed: the head moved past the recorded head, or the quiet window elapsed. A pause with no parseable
 *               time is treated as old (re-armed) — an unreadable timestamp must not bury a PR.
 * @returns {null | {held:boolean, pause:object, why:string}}
 */
export function concurrentAuthorPauseState({ comments, headRefOid = null, now = 0, quietMs = CONCURRENT_AUTHOR_QUIET_MS }) {
  const pauses = concurrentAuthorPauses(comments);
  if (!pauses.length) return null;
  const pause = pauses[pauses.length - 1];
  const headMoved = Boolean(pause.head && headRefOid && pause.head !== headRefOid);
  const at = Date.parse(pause.createdAt ?? '');
  const quiet = !Number.isFinite(at) || !now || now - at >= quietMs;
  if (headMoved) return { held: false, pause, why: 're-armed: the PR head moved past the paused head' };
  if (quiet) return { held: false, pause, why: `re-armed: the head has been quiet for ${Math.round(quietMs / 60000)}+ minutes since the pause` };
  return { held: true, pause, why: 'a fixer paused for a concurrent author on this head — re-arms on the next head or after the quiet window' };
}

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
  REFERRAL_HOLD_MARKER,
  REARM_COMMENT_MARKER, CI_HEAL_COMMENT_MARKER, STAND_DOWN_MARKER, SUPERSEDE_STAND_DOWN_MARKER, OPERATOR_ANSWER_MARKER,
  // #xkmu3gv — the two new completed-round markers. Neither is a reviewer speaking, so neither may ever count as
  // a finding (`countFindings`) or the pass would read its OWN handback comment as fresh work to fix.
  CONFLICT_FIX_COMMENT_MARKER, ADVISORY_FIX_COMMENT_MARKER,
  // we:backlog/heal-wait-for-rerun — a ci-heal escalation is this loop's OWN bookkeeping too: a PR whose head
  // has since moved past a ci-red phase but still carries an old escalation comment in its history must not
  // have that comment misread as a fresh reviewer finding.
  CI_HEAL_ESCALATION_MARKER,
  // fix procedure (operator-approved 2026-09-27) — the fix claim's begin/end markers and the non-terminal
  // concurrent-author pause are the loop's own bookkeeping, never a reviewer's finding.
  FIX_BEGIN_MARKER, FIX_END_MARKER, CONCURRENT_AUTHOR_PAUSE_MARKER,
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
 * cap, counted by `we:scripts/conveyor/conflict-fix-round-count.mjs#countStaleConflictFixRounds` (2026-09-27:
 * counts only rounds against the CURRENT target, see {@link CONFLICT_FIX_ABSOLUTE_CEILING}'s own docblock for
 * why a plain per-marker count was wrong) — never `roundCap`'s shared rearm/advisory counters, and never
 * reduced by however many ordinary negotiation rounds a
 * PR has already spent (CONFIRMED LIVE: `web-everything/web-everything#2549` was already at 5 of 5 ordinary rounds
 * when PR #2577's routing rule newly offered it a conflict fix, and the shared cap refused it before the fixer
 * ever ran — see that leaf's own header for the full incident). A PR that ALSO exhausts three
 * conflict-resolution rounds still needs a person, exactly as an exhausted `roundCap` does.
 */
export const CONFLICT_FIX_ROUND_CAP = 3;

/**
 * we:scripts/conveyor/reconcile-core.mjs#CONFLICT_FIX_ABSOLUTE_CEILING — PR #2787 live incident (2026-09-27):
 * `main` moving fast made THREE mechanical conflict-resolution rounds each genuinely SUCCEED (each posted its
 * own {@link CONFLICT_FIX_COMMENT_MARKER}) against three DIFFERENT targets in a row (a stacked base rebased
 * twice, then the base itself landed and the PR retargeted to `main`) — `countConflictFixComments` could not
 * tell "the same conflict still unresolved" apart from "a fresh conflict against newer work", so
 * {@link CONFLICT_FIX_ROUND_CAP} (3) was spent on three CLEAN repairs and the fourth, genuinely first-ever
 * main-base conflict was refused `cap-exhausted` before a fixer ever tried it.
 * {@link countStaleConflictFixRounds} now counts against `CONFLICT_FIX_ROUND_CAP` only the rounds that resolved
 * the SAME target this PR is STILL conflicting against (same ref, same sha where known) — a round against a
 * ref/sha that has since moved on doesn't count, because the mechanism worked; the PR just kept getting new
 * work under it. That alone would let a PR whose target genuinely never stops moving retry FOREVER, though
 * (every round would look "fresh" by construction) — this is the hard ceiling that still catches THAT true
 * loop: the RAW total of conflict-fix rounds ever run (`countStaleConflictFixRounds`'s own `total`), regardless
 * of staleness, still refuses `cap-exhausted` once it reaches this bound. 3x the per-target cap — generous
 * enough that a PR legitimately outrunning a fast-moving target for a while is not punished for it, but still
 * finite: a PR that needed this many rounds, of ANY kind, is exactly the "a person must take it over" case
 * {@link CONFLICT_FIX_ROUND_CAP} already exists to name.
 */
export const CONFLICT_FIX_ABSOLUTE_CEILING = CONFLICT_FIX_ROUND_CAP * 3;

/**
 * we:scripts/conveyor/reconcile-core.mjs#ADVISORY_FIX_ROUND_CAP — the durable cap an ADVISORY-FIX round on a
 * `needs-human` PR binds on (#xkmu3gv). Mirrors {@link CI_HEAL_ROUND_CAP} exactly: its OWN, smaller cap, counted
 * by `we:scripts/conveyor/advisory-fix-mark.mjs#countCompletedAdvisoryEpisodes` (xconv1-evidence follow-up,
 * 2026-09-27 — counts completed note→fix EPISODES, never raw fix-mark comments, so multiple fixes clustered
 * inside one still-broken episode can never buy extra tries NOR unfairly spend a brand-new finding's own
 * budget; see that function's own docblock for the live #2766/#2767 incident this replaces) — never `roundCap`'s shared
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
 * we:scripts/conveyor/reconcile-core.mjs#failingCheckNames — #4191 (epic #4075/#3383): the NAMED reason a
 * `ci-heal-exhausted` note surfaces, so the operator reads "which check, still failing" instead of a bare
 * attempt count. Mirrors `we:scripts/operations/operator-queue.mjs#evaluatePr`'s own `names(failing)` filter
 * (`status === 'COMPLETED'` and a non-passing conclusion) rather than inventing a second rule for the same
 * question — this file already reads `pr.statusCheckRollup` for `reduceCheckState`'s own `check.state`, this
 * just names the specific rows behind a `red` state instead of only counting them. Pure.
 * @param {Array<{name?:string, context?:string, status?:string, conclusion?:string}>} [rollup]
 * @returns {string[]}
 */
const failingCheckNames = (rollup) => (Array.isArray(rollup) ? rollup : [])
  .filter((c) => String(c?.status ?? '').toUpperCase() === 'COMPLETED'
    && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(String(c?.conclusion ?? '').toUpperCase()))
  .map((c) => c?.name || c?.context || 'unnamed check');

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

/** Current finding episode, not PR creation/update time: a new round goes to the back
 * of the overlap queue. Bookkeeping comments cannot move a waiting PR backwards. */
export function fixWaitingSince(comments) {
  const trusted = (Array.isArray(comments) ? comments : []).filter(isTrustedMarkerAuthor);
  const findings = trusted.filter((c) => countFindings([c]) > 0);
  // Prefer the actual review episode. Queue-cap notices and operator chatter must
  // not reset its age. Legacy unstructured findings use their first dated note.
  const reviews = findings.filter((c) => c.body.trimStart().startsWith(ADVISORY_NOTE_MARKER)
    || c.body.trimStart().startsWith('🔁 review — changes requested'));
  const times = (reviews.length ? reviews : findings)
    .map((c) => Date.parse(c?.createdAt)).filter(Number.isFinite);
  if (!times.length) return null;
  // A consumed turn cannot retain priority if its session settles without a new
  // verdict. Begin/end markers prove it consumed a turn; end timestamps put it
  // behind arrivals that waited while that turn was running.
  const turns = trusted.filter((c) => [FIX_BEGIN_MARKER, FIX_END_MARKER]
    .some((marker) => c.body?.trimStart().startsWith(marker)))
    .map((c) => Date.parse(c.createdAt)).filter(Number.isFinite);
  const findingTime = reviews.length ? Math.max(...times) : Math.min(...times);
  return new Date(Math.max(findingTime, ...turns)).toISOString();
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
 *
 * `transcriptAgeMs` (#4056) rides along as EVIDENCE only — how long ago the bound session's own transcript last
 * moved, copied off the agent row when an IO shell has already measured it (`pr-ownership-io.mjs`), else `null`.
 * It never participates in the bind decision; the `pr-ownership` read uses it to flag a stale binding (#3951).
 * @param {{headRefOid?:string, number?:number|string}} pr
 * @param {Array<object>} agents
 * @returns {Array<{agent:object, cwd:string, sha:string, transcriptAgeMs:number|null}>}
 */
export function bindAgents(pr, agents, repo = 'we') {
  const sha = String(pr?.headRefOid ?? '');
  const list = Array.isArray(agents) ? agents : [];
  const bound = new Map();
  const row = (a) => ({
    agent: a, cwd: String(a.cwd ?? ''), sha,
    transcriptAgeMs: Number.isFinite(a.transcriptAgeMs) ? a.transcriptAgeMs : null,
  });

  if (sha) {
    for (const a of list) {
      if (a && String(a.laneHeadOid ?? '') && String(a.laneHeadOid) === sha) {
        bound.set(a, row(a));
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
        bound.set(a, row(a));
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

/**
 * we:scripts/conveyor/reconcile-core.mjs#countUnresolvedStandDowns — xaer296 (epic #3383): the stand-down count
 * REFUSAL 1 actually gates on. Like `we:scripts/conveyor/stand-down.mjs#countTerminalStandDowns`, except it ALSO
 * excludes a stand-down `we:scripts/conveyor/advisory-fix-mark.mjs#isAdvisoryMechanismStandDownSuperseded` proves
 * was a mechanism failure (a fixer in ADVISORY-FIX MODE wrongly stood down instead of hand-back, on a finding the
 * thread already shows was fixed before it ran) — unioned with the existing watcher-supersede exclusion the same
 * way `bindAgents`'s two liveness paths are unioned ("a union of weak proxies raises confidence; either one alone
 * does not" does not apply here — these are two INDEPENDENT, narrow, mechanically-provable exclusions, and only
 * ONE needs to hold to exclude a given stand-down). Composed here, not folded into `countTerminalStandDowns`
 * itself: that function lives in `stand-down.mjs`, a deliberate leaf with no imports of its own, and importing
 * `advisory-fix-mark.mjs` back into it would be circular (that file already imports FROM `stand-down.mjs`). This
 * file already imports both, so the union lives here — the one place both leaves meet.
 *
 * #3383 — ALSO requires {@link isTrustedMarkerAuthor} (automation OR the repo operator) before a stand-down
 * counts at all. This function re-derives the leading-line match itself (rather than calling
 * `stand-down.mjs#countTerminalStandDowns`, which now carries the identical requirement) so its own three
 * supersede exclusions can run inline — but that means the trusted-author gate must be repeated here too, or a
 * comment from ANY GitHub account with this exact leading line would count as terminal again, the precise
 * adversarial-coverage-review finding this item closes (WE's PRs are public; a forged stand-down here
 * permanently blocks a fixer, no decay, no clock).
 * @param {Array<{body?:string, viewerDidAuthor?:boolean, author?:{login?:string}}|string>|null|undefined} comments
 * @returns {number}
 */
export function countUnresolvedStandDowns(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  for (let i = 0; i < comments.length; i += 1) {
    const c = comments[i];
    const body = typeof c === 'string' ? c : c?.body;
    if (typeof body !== 'string' || !body.trimStart().startsWith(STAND_DOWN_MARKER)) continue;
    if (!isTrustedMarkerAuthor(c)) continue; // #3383 — a forged stand-down from an untrusted login is never terminal.
    // fix procedure — a concurrent-author stand-down (the #2811 shape) is reclassified as a re-armable pause,
    // handled by {@link concurrentAuthorPauseState}, never terminal here.
    if (isConcurrentAuthorStandDown(c)) continue;
    if (isStandDownSuperseded(comments, i)) continue;
    if (isAdvisoryMechanismStandDownSuperseded(comments, i)) continue;
    if (isOperatorAnswerStandDownSuperseded(comments, i)) continue;
    n += 1;
  }
  return n;
}

/** How long after a review/fix session reports `blocked-on-infra` before it counts as finished, so the PR is
 *  retried. Long enough that a persistent outage (a spent rate limit, GitHub down) is not hammered by a fresh
 *  agent every two-minute tick; short enough that a recovered outage is retried within one coffee. */
export const INFRA_RETRY_COOLOFF_MS = 15 * 60 * 1000;

/**
 * we:scripts/conveyor/reconcile-core.mjs#INFRA_RETRY_CAP — xilx617 (epic #4075/#3383): the durable per-SESSION
 * `blocked-on-infra` STREAK cap. Today a session that self-reports `blocked-on-infra` cools off
 * {@link INFRA_RETRY_COOLOFF_MS} and is re-dispatched, forever — no cap, no escalation
 * (`we:scripts/conveyor/flows/fix.flow.json#fixer-blocked-infra`/`review.flow.json#blocked-on-infra`,
 * `uncapped-retry`, xb4yerj). The streak itself is persisted by the completion STORE's own write path
 * ({@link ../operations/completion-store.mjs#writeCompletion}), never derived here — this file only reads
 * `infraStreak` back off the record {@link markSelfReportedDone} is handed. At the cap the PR is not blocked
 * further — infra may still recover — but its cool-off grows to {@link INFRA_RETRY_CAPPED_COOLOFF_MS} and
 * {@link planReconcile} pushes a `kind:'infra-retry-exhausted'` note, mirroring the `ci-heal-exhausted`/
 * `round-cap-exhausted` "refuse AND surface" treatment above.
 */
export const INFRA_RETRY_CAP = 4;

/** we:scripts/conveyor/reconcile-core.mjs#INFRA_RETRY_CAPPED_COOLOFF_MS — the lengthened cool-off (60 minutes)
 *  once a session's `blocked-on-infra` streak reaches {@link INFRA_RETRY_CAP}. The retry loop is never stopped
 *  outright (a persistent-but-eventually-recovering outage is real), only slowed and surfaced to a person. */
export const INFRA_RETRY_CAPPED_COOLOFF_MS = 60 * 60 * 1000;

/**
 * we:scripts/conveyor/reconcile-core.mjs#LIVE_SESSION_OVERRUN_MS — xilx617 (epic #4075/#3383): the default bound
 * past which a `live-process` refusal (a bound session with a probed-live pid — see {@link assessLiveness}) also
 * gets a surfaced `kind:'session-overrun'` note, so a session that has been "just working" for hours does not
 * stay invisible the way the `ci-heal-session-running` flow state did before this cap
 * (`we:scripts/conveyor/flows/ci-heal.flow.json#ci-heal-session-running`, `unbounded-wait`, xwo3j0l). NEVER
 * kills or reaps the session — this pass only ever refuses and, past the bound, ALSO notes; the fix stays
 * "still refuse" exactly like `awaiting-permission` above. Overridable via {@link planReconcile}'s own
 * `liveSessionOverrunMs` option (tests set it directly) — no env read in this pure core.
 */
export const LIVE_SESSION_OVERRUN_MS = 90 * 60 * 1000;

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
 *
 * #4149 (epic #3383/#4075) — `we:scripts/conveyor/session-reaper.mjs#makeCompletionResolver` no longer keeps a
 * `blocked-on-infra` session's OS PROCESS alive for the cool-off (it now `claude stop`s it as soon as the record
 * says `done`, regardless of outcome — that function's own doc has the full incident). The RECORD, not the
 * process, is what must still hold the line during the cool-off, so a row still inside the window is now marked
 * `awaitingInfraCooloff: true` — DISTINCT from `selfReportedDone` — so {@link assessLiveness} can tell "this
 * session is done and its process is gone, but the cool-off it reported is still running" apart from "genuinely
 * finished, available for redispatch", REGARDLESS of whether the listing's own `state` already reads `'stopped'`
 * (which it now typically will, immediately, rather than staying `blocked`/`working` for the cool-off's
 * duration).
 * #4306 (epic #3383/#4075, BLOCKER fix-2821) — "a completion record only ever speaks for the session that
 * wrote it": when `rec.sessionId` is set and differs from this row's OWN `a.sessionId`, the record is a
 * DIFFERENT generation's (a still-live one, in the incident that named this card) — never treated as this
 * row's completion, however its `status`/`updatedAt` read, and NEVER downgraded to the legacy (no-`sessionId`)
 * rule just because the mismatch check ran. A record with no `sessionId` (predating this card, or written by a
 * caller with no session identity, e.g. `we:scripts/operations/review-job.mjs`) keeps today's rule unchanged.
 * @param {Array<object>} agents - the `claude agents --json` rows
 * @param {(name:string)=>({status?:string, outcome?:string, updatedAt?:string, sessionId?:string|null}|null)} completionFor
 * @param {number} nowMs
 * @returns {Array<object>} the same rows; finished ones gain `selfReportedDone: true` and `selfReportedOutcome`;
 *   a row still inside its own `blocked-on-infra` cool-off gains `awaitingInfraCooloff: true` instead
 */
export function markSelfReportedDone(agents, completionFor, nowMs) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    const name = a?.name;
    if (!name || String(a?.state ?? '').toLowerCase() === 'done') return a;
    let rec = null;
    try { rec = completionFor(String(name)); } catch { rec = null; }
    if (!rec || rec.status !== 'done') return a;
    // #4306 — foreign-`sessionId` check, BEFORE the timestamp check below (see this function's own doc above).
    // Sourced from the ONE shared predicate every reader/writer binds through now
    // (`we:scripts/operations/completion-record.mjs#isForeignCompletionSessionId`) — this was previously the
    // strictest of the three inline checks; an independent review found the other two more lenient (accepting
    // a foreign record when the ROW carried no `sessionId` of its own), which this shared predicate closes.
    if (isForeignCompletionSessionId(a?.sessionId, rec.sessionId)) return a;
    const updatedMs = Date.parse(rec.updatedAt ?? '');
    const startedMs = startedAtMs(a?.startedAt);
    if (!Number.isFinite(updatedMs) || !Number.isFinite(startedMs) || updatedMs < startedMs) return a;
    if (rec.outcome === 'blocked-on-infra') {
      // xilx617 (epic #4075/#3383) — the durable per-session streak the completion STORE's own write path
      // maintains (`we:scripts/operations/completion-store.mjs#writeCompletion`); read back here, never
      // recomputed. A streak at or above `INFRA_RETRY_CAP` gets the LONGER cool-off — the retry continues,
      // slower, because infra may still recover — and is carried on the row so {@link planReconcile} can push
      // its own `infra-retry-exhausted` note for the PR this session is bound to.
      const infraStreak = Number.isInteger(rec.infraStreak) && rec.infraStreak > 0 ? rec.infraStreak : 1;
      const infraStreakSince = rec.infraStreakSince ?? rec.updatedAt ?? null;
      const infraStreakCapped = infraStreak >= INFRA_RETRY_CAP;
      const cooloffMs = infraStreakCapped ? INFRA_RETRY_CAPPED_COOLOFF_MS : INFRA_RETRY_COOLOFF_MS;
      if (!(nowMs - updatedMs >= cooloffMs)) {
        // #4149 — the process may already be `stopped` (or on its way there) this very tick; the cool-off must
        // outrank that, since it is keyed off the RECORD, never off whether a process happens to still be listed.
        return {
          ...a, awaitingInfraCooloff: true, infraStreak, infraStreakSince, infraStreakCapped,
        };
      }
      return {
        ...a, selfReportedDone: true, selfReportedOutcome: rec.outcome ?? null, infraStreak, infraStreakSince, infraStreakCapped,
      };
    }
    return { ...a, selfReportedDone: true, selfReportedOutcome: rec.outcome ?? null };
  });
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#markHungSessions — mark each listed session whose OWN transcript file
 * has gone stale as `hung: true`. Pure (the classification is injected via `hungInfoFor`); modeled directly on
 * {@link markSelfReportedDone} just above — a SEPARATE pre-pass over AGENT rows, run before {@link
 * assessLiveness}, never a change to that pinned function itself.
 *
 * WHY THIS EXISTS, SEPARATELY FROM `markSelfReportedDone` (epic #3383 continuation, live 2026-09-24,
 * web-everything/web-everything #2599/#2596/#2594/#2588/#2587/#2582): those six PRs' bound review sessions never
 * wrote a `status: done` completion record — the review brief's "report done on infra failure" instruction is
 * PROSE, and an agent that crashes/exits under stress can skip it — so `markSelfReportedDone` never fires for
 * them and `assessLiveness` keeps reading them as live, freezing the PR forever. This is a THIRD, MECHANICAL
 * signal that does not depend on the dispatched agent reporting anything: see
 * `we:scripts/conveyor/hung-session.mjs` for the shared pure-core/IO-shell detector (also imported by
 * `we:scripts/conveyor/session-reaper.mjs`'s hung axis — ONE implementation, not two).
 *
 * @param {Array<object>} agents - the `claude agents --json` rows (optionally already carrying
 *   `selfReportedDone` from {@link markSelfReportedDone}, run first).
 * @param {(agent:object, nowMs:number, thresholdMs:number) => ({hung:boolean, reason?:string, ageMs?:number|null}|null)} hungInfoFor
 * @param {number} nowMs
 * @param {number} thresholdMs
 * @returns {Array<object>} the same rows; hung ones gain `hung: true`, `hungReason`, `hungAgeMs`
 */
export function markHungSessions(agents, hungInfoFor, nowMs, thresholdMs) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    if (!a) return a;
    if (String(a?.state ?? '').toLowerCase() === 'done' || a?.selfReportedDone === true) return a;
    let info = null;
    try { info = hungInfoFor(a, nowMs, thresholdMs); } catch { info = null; }
    if (!info || info.hung !== true) return a;
    return { ...a, hung: true, hungReason: info.reason ?? null, hungAgeMs: Number.isFinite(info.ageMs) ? info.ageMs : null };
  });
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#markBgIsolationStalls — #x9fbg1x: mark each listed session ALREADY
 * classified {@link isAwaitingPermission} whose OWN transcript shows Claude Code's own background-session
 * worktree-isolation guard refusal ("Call EnterWorktree first…") as `bgIsolationStall: true`. Pure (the
 * classification is injected via `stallInfoFor`); modeled directly on {@link markHungSessions} just above —
 * a SEPARATE pre-pass over AGENT rows, run before {@link assessLiveness}, never a change to that pinned
 * function itself (which only reads the flag this pass attaches).
 *
 * ONLY CALLS `stallInfoFor` FOR A SESSION ALREADY AWAITING PERMISSION — cheap by construction: every other
 * session skips a transcript read entirely, so this pass costs nothing on the common (not-stuck) path. See
 * `we:scripts/conveyor/bg-isolation-stall.mjs` for the detector (a THIRD mechanical signal in the same family
 * as `we:scripts/conveyor/hung-session.mjs`, reusing its exact transcript-tail-read machinery).
 * @param {Array<object>} agents - the `claude agents --json` rows.
 * @param {(agent:object) => ({stall:boolean, reason?:string, evidence?:string|null})} stallInfoFor
 * @returns {Array<object>} the same rows; stalled ones gain `bgIsolationStall: true`, `bgIsolationStallEvidence`
 */
export function markBgIsolationStalls(agents, stallInfoFor) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    if (!a) return a;
    if (!isAwaitingPermission(a)) return a; // cheap skip — see docblock
    let info = null;
    try { info = stallInfoFor(a); } catch { info = null; }
    if (!info || info.stall !== true) return a;
    return { ...a, bgIsolationStall: true, bgIsolationStallEvidence: info.evidence ?? null };
  });
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#markAuthExpiredSessions — mark each listed session whose OWN
 * transcript ends on the Claude CLI's own synthetic auth-failure turn (`isApiErrorMessage` with an
 * `authentication_failed` error or `Login expired · Please run /login`) as `authExpired: true`. Pure (the
 * classification is injected via `authExpiredInfoFor`); modeled directly on {@link markHungSessions} just
 * above — a SEPARATE pre-pass over AGENT rows, run before {@link assessLiveness}, never a change to that
 * pinned function itself.
 *
 * WHY THIS EXISTS, SEPARATELY FROM `markHungSessions` (live incident, night of 2026-09-25/26 ET): the
 * operator's own Claude login expired, so every daemon-dispatched session (`ci-heal-2711`/`ci-heal-2712`,
 * re-dispatched repeatedly until 06:53) ended IMMEDIATELY with one synthetic assistant turn carrying the CLI's
 * own auth-failure text — never producing another transcript line for anything to go stale on. Left to
 * `markHungSessions`'s own 30-minute default threshold, each session would eventually be caught, but (a) that
 * is 30+ minutes per session of `reconcile-refused live-process` noise this pass emits instead of dispatching a
 * fresh fixer, all night, and (b) the reaper (`we:scripts/conveyor/session-reaper.mjs`) that would otherwise
 * `claude stop` these sessions promptly shares the identical blind spot — see that file's own Claude-auth-
 * expired axis, built alongside this one, reading the SAME shared detector
 * (`we:scripts/conveyor/hung-session.mjs#readClaudeAuthExpiredInfo` — ONE implementation, not two, mirroring
 * `markHungSessions`'s own `hung-session.mjs` reuse).
 *
 * A `ci-heal` session GAINED a completion-record schema #4075/xg7m2wq ({@link
 * ../operations/completion-record.mjs#COMPLETION_KINDS} now has a `ci-heal` entry — see
 * `session-reaper.mjs#BACKSTOP_COMPLETION_KINDS`'s own doc for the live incident that added it), so an
 * auth-failure exit now CAN leave a real `outcome:'blocked-on-infra'` record for one, same as `review`/`fix`.
 * This mark stays regardless: it catches the auth-failure the INSTANT it shows in the transcript, without
 * waiting on whatever report step the dispatched brief did or didn't reach before the CLI cut it off, and it
 * still applies unchanged to a session whose kind carries no completion-record schema at all.
 * @param {Array<object>} agents - the `claude agents --json` rows (optionally already carrying `selfReportedDone`
 *   from {@link markSelfReportedDone} and/or `hung` from {@link markHungSessions}, run first).
 * @param {(agent:object) => ({authExpired:boolean, reason?:string}|null)} authExpiredInfoFor
 * @returns {Array<object>} the same rows; auth-expired ones gain `authExpired: true`, `authExpiredReason`
 */
export function markAuthExpiredSessions(agents, authExpiredInfoFor) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    if (!a) return a;
    if (String(a?.state ?? '').toLowerCase() === 'done' || a?.selfReportedDone === true || a?.hung === true) return a;
    let info = null;
    try { info = authExpiredInfoFor(a); } catch { info = null; }
    if (!info || info.authExpired !== true) return a;
    return { ...a, authExpired: true, authExpiredReason: info.reason ?? null };
  });
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#markIdleFinishedSessions — mark each listed session whose OWN
 * transcript shows its last assistant turn fully ENDED (no pending tool call) and has sat idle past a short
 * threshold, as `idleFinished: true`. Pure (the classification is injected via `idleFinishedInfoFor`); modeled
 * directly on {@link markAuthExpiredSessions} just above — a SEPARATE pre-pass over AGENT rows, run before
 * {@link assessLiveness}, never a change to that pinned function itself.
 *
 * WHY THIS EXISTS, SEPARATELY FROM EVERY AXIS ABOVE (#4075/xg7m2wq, live incident PR #2724, 2026-09-26).
 * `markSelfReportedDone` only fires once a dispatched agent's OWN brief tells it to report completion — and
 * `fix-agent-ci-brief.md` never did, for any outcome, until this same card fixed it (see
 * `../operations/completion-record.mjs#COMPLETION_KINDS`). `markHungSessions`/`markAuthExpiredSessions` cover
 * a stale transcript and an auth failure respectively, but neither is a general backstop for "the brief itself
 * forgot the report step" across every OTHER kind this file's other axes don't name at all
 * (`conveyor`/`prepare`/`prepare-decision`/`investigate`/a future kind not yet invented). This axis is that
 * general backstop: it needs no kind-specific schema entry and no brief cooperation at all — it just reads
 * whether the session's own last turn is genuinely over (see {@link
 * ../hung-session.mjs#classifyIdleFinished} for why a pending tool call is an absolute gate, never merely
 * extra grace, which is what makes a much shorter default threshold safe here).
 *
 * Run LAST, after every other axis, so a real self-report / hung / auth-expired verdict always wins first —
 * this is the least specific signal of the four and should never race a more specific one.
 * @param {Array<object>} agents - the `claude agents --json` rows (optionally already carrying `selfReportedDone`,
 *   `hung`, `authExpired` from the earlier passes, run first).
 * @param {(agent:object, nowMs:number, thresholdMs:number) => ({finished:boolean, reason?:string, ageMs?:number|null}|null)} idleFinishedInfoFor
 * @param {number} nowMs
 * @param {number} thresholdMs
 * @returns {Array<object>} the same rows; idle-finished ones gain `idleFinished: true`, `idleFinishedReason`
 */
export function markIdleFinishedSessions(agents, idleFinishedInfoFor, nowMs, thresholdMs) {
  return (Array.isArray(agents) ? agents : []).map((a) => {
    if (!a) return a;
    if (String(a?.state ?? '').toLowerCase() === 'done' || a?.selfReportedDone === true || a?.hung === true || a?.authExpired === true) return a;
    let info = null;
    try { info = idleFinishedInfoFor(a, nowMs, thresholdMs); } catch { info = null; }
    if (!info || info.finished !== true) return a;
    return { ...a, idleFinished: true, idleFinishedReason: info.reason ?? null };
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
 *
 * AND the same holds for a session {@link markHungSessions} has independently confirmed HUNG (`hung: true`) —
 * epic #3383 continuation, live 2026-09-24. This is a DIFFERENT fact from `transcriptMtimeMs` above: that field
 * is PR-level evidence this function is pinned to never consult; `hung` is a pre-computed AGENT-level verdict
 * from a separate detector (`we:scripts/conveyor/hung-session.mjs`) that this function trusts exactly the way
 * it already trusts `selfReportedDone` — as an upstream fact, not a raw timestamp it would otherwise have to
 * interpret itself. Excluding it here is what lets a `state: 'working'`-but-actually-dead session stop reading
 * as `live-process` and free its PR to be reconciled again.
 *
 * AND the same holds for a session {@link markAuthExpiredSessions} has independently confirmed hit the Claude
 * CLI's own auth-failure (`authExpired: true`) — live incident, night of 2026-09-25/26 ET. Same reasoning as
 * `hung` immediately above: an upstream, pre-computed AGENT-level fact from a separate detector
 * (`we:scripts/conveyor/hung-session.mjs#readClaudeAuthExpiredInfo`) this function trusts exactly the way it
 * already trusts `selfReportedDone`/`hung`. Excluding it here is the fix for the live incident's own reconcile
 * symptom: `reconcile-refused live-process … PR #2711` / `#2712` — these sessions had a LIVE pid (never
 * stopped promptly) and no self-report, so without this exclusion they read as `live-process` FOREVER, and the
 * fix-dispatch daemon never sent a fresh fixer even after the operator logged back in.
 *
 * `state === 'stopped'` is ALSO finished — live-caught 2026-09-25 (PR #2647/#2625, both `web-everything/web-everything`,
 * both stuck at an informative `review-status:review-stalled`/`reviewing` label with nothing live and nothing
 * retrying). Root cause, confirmed against a real `claude agents --json --all` listing off the running review
 * daemon's own checkout: `we:scripts/conveyor/session-reaper.mjs` calls `claude stop` on every `done`/`failed`/
 * hung session it reaps (its own `TERMINAL_REAP_STATES`/`ALREADY_STOPPED_STATES`), which flips that session's OWN
 * listed `state` to `'stopped'` — a state THIS function's `isFinished` never checked. `we:scripts/conveyor/
 * reconcile-pass.mjs#enrichAgents` OMITS `pidAlive` entirely once `pid` itself is no longer on the row (measured:
 * every `stopped`/`done` row in that same live listing carries no `pid` at all — only a currently-`working` row
 * does), so an unfiltered `stopped` row reaches rank 3 (`pidAlive !== false`) and returns `liveness-unknown` —
 * REFUSING a fresh dispatch for a PR whose bound session cannot possibly become live again. `bindAgents` binds
 * every historical session sharing a PR's `review-<pr>`/`fix-<pr>` name, live or not (no `startedAt` filter), so
 * ONE such stale `stopped` row is enough to freeze the PR even while every other bound row is cleanly `done`. A
 * `stopped` session, by session-reaper's own definition (`ALREADY_STOPPED_STATES`), never resumes and never
 * produces another `state` transition on its own — mirroring that finality here, the same way `done` already is,
 * is what frees the PR to be reconciled again rather than parking it at `liveness-unknown` forever.
 *
 * AND the same holds for a session {@link markIdleFinishedSessions} has independently confirmed idle past its
 * last-turn-ended threshold (`idleFinished: true`) — #4075/xg7m2wq, live incident PR #2724, 2026-09-26. Same
 * upstream-fact reasoning as `hung`/`authExpired` immediately above, and the general backstop for every kind
 * that has no self-report axis of its own at all (see that function's own doc).
 *
 * THE ONE EXCEPTION TO `state === 'stopped'` MEANING FINISHED (#4149, epic #3383/#4075): a row
 * {@link markSelfReportedDone} marked `awaitingInfraCooloff: true` is NOT finished, even though session-reaper
 * now stops that process immediately (see that function's own doc) and the listing may therefore already read
 * `'stopped'` here. The cool-off is a fact about the RECORD (a persistent outage should not be retried every
 * tick), never about whether an OS process is still around to babysit it — so this check is read FIRST, ahead
 * of the blanket `state === 'stopped'` clause below, the same "an upstream fact outranks a raw listing read"
 * precedent `selfReportedDone`/`hung` already established.
 * @param {Array<{agent:object, cwd:string, sha:string}>} bound
 * @returns {{kind:string, pid:number|null, cwd:string, sha:string, sessionId:string|null, why:string}|null}
 */
export function assessLiveness(bound) {
  const isFinished = (agent) => {
    if (agent?.awaitingInfraCooloff === true) return false; // #4149 — the record's cool-off outranks `state`
    const state = String(agent?.state ?? '').toLowerCase();
    return state === 'done' || state === 'stopped' || agent?.selfReportedDone === true || agent?.hung === true
      || agent?.authExpired === true || agent?.idleFinished === true;
  };
  const list = (Array.isArray(bound) ? bound : []).filter((b) => !isFinished(b.agent));
  const ev = (b, kind, why) => ({
    kind,
    pid: Number.isInteger(b.agent?.pid) ? b.agent.pid : null,
    cwd: b.cwd,
    sha: b.sha,
    sessionId: b.agent?.sessionId ?? null,
    // xilx617 (epic #4075/#3383) — carried on EVERY verdict (not just `awaiting-permission`, which already set
    // its own copy below): `session-overrun` needs it for a `live-process` verdict too, and there is no reason
    // for the other two kinds not to carry it as well — it is EVIDENCE, the same "travels with the row" reason
    // `sha`/`cwd` already do.
    startedAt: b.agent?.startedAt ?? null,
    why,
  });

  for (const b of list) {
    if (isAwaitingPermission(b.agent)) {
      // #x9fbg1x — a MORE SPECIFIC reason, layered on top of the generic fifth state, when
      // `markBgIsolationStalls` (a separate pre-pass, mirroring `markHungSessions`) has already read this
      // session's OWN transcript and confirmed the block is Claude Code's own background-session
      // worktree-isolation guard ("Call EnterWorktree first…") rather than some other permission prompt. Never
      // changes `kind` (still `awaiting-permission` — the dispatch refusal is identical either way) or
      // `REFUSAL_KINDS`'s exhaustive set; purely an added, clearer `why`/`stallReason` for a human or the
      // health watch to act on precisely, rather than filing it under the same catch-all as every other
      // unanswerable prompt. See `we:scripts/conveyor/bg-isolation-stall.mjs` for the detector.
      const stalled = b.agent?.bgIsolationStall === true;
      return {
        ...ev(
          b,
          'awaiting-permission',
          stalled
            ? 'session is blocked on Claude Code\'s own background-session worktree-isolation guard ("Call EnterWorktree first…") — the dispatched session\'s lane clone already IS its isolation, so this is a product-fixable stall (bg-isolation-stall), not a genuine question for a human'
            : `session is blocked on "${String(b.agent.waitingFor)}" — a background agent has nobody to ask, so it will never advance on its own`,
        ),
        startedAt: b.agent?.startedAt ?? null,
        waitingFor: String(b.agent.waitingFor),
        ...(stalled ? { stallReason: 'bg-isolation-stall' } : {}),
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
 * The `refuse` a parallel-review caller injects into {@link dispatchReviewRow}: it FOLDS the review decision's
 * own refusal into the caller's existing refusal `row` as `reviewRefusal`, never a second row for the same PR
 * (PR #2783 review). ONE implementation for both callers (`owed-ci-rerun` and the `not-a-ci-break`
 * escalation — PR #2894 review): drops every key already on `withPhase` and the caller's own population
 * `markerKey` (it belongs on the dispatch row, not inside `reviewRefusal`), and tolerates a bare
 * `refuse(kind)` with no `extra`.
 * @param {object} row the caller's already-pushed refusal row
 * @param {object} withPhase
 * @param {string} markerKey e.g. `'owedCiRerun'`
 * @returns {(kind:string, extra?:object)=>void}
 */
export function foldReviewRefusalInto(row, withPhase, markerKey) {
  return (kind, extra) => {
    row.reviewRefusal = {
      kind,
      ...Object.fromEntries(Object.entries(extra ?? {}).filter(([k]) => !(k in withPhase) && k !== markerKey)),
    };
  };
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#ACCEPT_LABEL_GRACE_MS — how long an accept verdict comment may sit on a
 * head WITHOUT its `review:accepted` label before this pass reads the label write as DROPPED rather than still in
 * flight (we:backlog/4352). `review-set-label.mjs` posts the comment FIRST on a first accept
 * (`review-label-provider.mjs#writeOrder`), so a tick can legitimately land in the seconds between the two writes;
 * a window this wide is far past any live review session's own finish-to-label gap (the #2588 race), yet short
 * enough that a budget-dropped label is recovered within the same half hour.
 */
export const ACCEPT_LABEL_GRACE_MS = 15 * 60_000;

/**
 * we:scripts/conveyor/reconcile-core.mjs#acceptLabelDropped — does this head's accept verdict comment exist while
 * the label it should have produced does NOT (we:backlog/4352)? Pure. Every `reviewed-sha` marker is stamped by
 * an ACCEPT-shaped verdict (`accepted`/`clear-human`/`restamp`), whose label is `review:accepted` — so a PR still
 * `review:pending` on that exact head, well past {@link ACCEPT_LABEL_GRACE_MS}, is the stuck shape: the comment
 * posted, the swap was refused (a GitHub budget block), and nothing else will ever re-run it.
 *
 * Deliberately `review:pending` ONLY. A `review:human` PR carrying an accept marker is either the #xconv1
 * "accepted, then escalated" shape (legitimate — the label moved AFTER the verdict) or a dropped `clear-human`
 * swap, which a re-dispatched review cannot repair anyway (only the human ceremony clears `review:human`).
 * FAILS CLOSED: no clock (`now` 0), no timestamp on the verdict comment, or a still-fresh comment all answer
 * `false`, keeping the original `already-reviewed-head` refusal.
 * @param {{labels:string[], comments:Array<object>, headSha:string, now:number, graceMs?:number}} o
 * @returns {boolean}
 */
export function acceptLabelDropped({ labels, comments, headSha, now, graceMs = ACCEPT_LABEL_GRACE_MS }) {
  const names = Array.isArray(labels) ? labels : [];
  if (!names.includes(REVIEW_LABELS.pending) || names.includes(REVIEW_LABELS.accepted) || names.includes(REVIEW_LABELS.human)) return false;
  if (!now) return false;
  const verdict = findAcceptVerdictComment(comments, headSha);
  const at = verdict?.createdAt ? Date.parse(verdict.createdAt) : NaN;
  return Number.isFinite(at) && now - at >= graceMs;
}

/**
 * xuxcsw6 — the human-parked referral hold gates EVERY review emission, not only {@link dispatchReviewRow}.
 * The two advisory-fix branches push `kind: 'review'` directly; a parked review posts no fresh advisory note,
 * so their "fix postdates the advisory" test stayed true and re-dispatched a full review each tick on an
 * unchanged head (live 2026-10-04, #3771). Wake-ups (new head, a ruling, a send-back) clear `pr.referralHold`.
 */
function refuseReferralHold({ pr, refuse, withPhase, extra = {} }) {
  if (!pr?.referralHold) return false;
  refuse('review-referrals-pending', {
    ...withPhase, ...extra, referralHold: pr.referralHold, why: pr.referralHold.why,
  });
  return true;
}

/** A shared prerequisite for every review emission, including advisory review branches. */
function reviewChecksAllow({ pr, requiredChecks, refuse, withPhase, extra = {} }) {
  const ci = reviewCiGate({ headSha: pr?.headRefOid, requiredChecks, checks: pr?.statusCheckRollup });
  if (!ci.allowed) refuse('review-ci', {
    ...withPhase, ...extra, ci,
    why: `${ci.reason}: ${ci.affected.map(row => `${row.name}=${row.reason}`).join(', ')}`,
  });
  return ci.allowed;
}

/**
 * Common review decision. Preserve draft, reviewed-head, advisory conversion and cap semantics;
 * require complete successful CI immediately before emitting a review. CI-rerun and escalation
 * callers fold this refusal into their existing row so their repair ownership remains visible.
 */
function dispatchReviewRow({
  pr, requiredChecks, withPhase, base, attempts, roundCap, refuse, refuseCapExhausted, dispatch, extra = {}, now = 0,
}) {
  if (refuseReferralHold({ pr, refuse, withPhase, extra })) return;
  // ── `draft` (draft-first PRs, operator-approved 2026-09-27) — checked FIRST, ahead of every other refusal
  // in this function, including `already-reviewed-head`: a draft PR is never owed a review no matter what its
  // `review:*` label or its comment thread says, because GitHub itself will not surface it for review and
  // this pass's whole review-dispatch mechanism exists to fill that surface, not to pre-empt it. This closes
  // the measured incident that motivated the feature: `--park` used to apply the review label the instant the
  // PR opened, before its OWN first CI run had even finished (6 of 26 PRs, one night) — the review daemon
  // read the label alone and dispatched anyway. `promote-draft` (see `DISPATCH_KINDS`) is the only path back
  // out of this refusal: once the PR's required checks are all green, `gh pr ready` un-drafts it and the very
  // next tick reaches this function with `pr.isDraft` false, same as any other PR.
  if (pr?.isDraft) {
    refuse('draft', {
      ...withPhase, ...extra,
      why: 'PR is still a draft — no independent review is dispatched until it is promoted to ready for '
        + 'review, which happens once its required checks are all green (draft-first PRs)',
    });
    return;
  }
  // ── `already-reviewed-head` (#2588) — see {@link planReconcile}'s note ahead of its call for the full incident.
  // Raw-SHA comparison only, as it always was. A mechanically-REBASED accepted PR cannot reach this function
  // with a stale marker: an accept moves the label to `review:accepted`, which the OWED table never owes a review
  // (phase `queued`) and the ci-red-parallel caller never calls this for (it is gated on `review:pending`) —
  // defended by the "accepted contribution awaiting its mechanical rebase's CI" test in reconcile-core.test.mjs.
  //
  // we:backlog/4352 — the marker alone OVER-TRUSTED "review is done": an accept whose `review:accepted` swap a
  // GitHub budget block refused leaves the comment (it posts first) on a still-`review:pending` head, and this
  // refusal then held it there forever — nothing else re-runs `review-set-label.mjs` for it. So the refusal now
  // also requires the live label to agree with the verdict; a head whose label disagrees past the grace window
  // ({@link acceptLabelDropped}) falls through to the ordinary review dispatch below — the existing re-run path,
  // whose verdict run re-applies the label — carrying `relabelOwed: true` so the report names why.
  const headSha = typeof pr?.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
  const reviewedSha = headSha ? parseReviewedSha(pr?.comments) : null;
  const relabelOwed = !!(headSha && reviewedSha && reviewedSha === headSha)
    && acceptLabelDropped({ labels: withPhase?.labels, comments: pr?.comments, headSha, now });
  if (relabelOwed) extra = { ...extra, relabelOwed: true };
  if (headSha && reviewedSha && reviewedSha === headSha && !relabelOwed) {
    // #xconv1 (web-everything/web-everything#2766/#2767 unblock, epic #3383/#4075) — a `needs-human` PR in this
    // EXACT shape (accepted, then escalated — never a fresh push, or `reviewedSha` would no longer equal
    // `headSha`) is NOT the #2588 risk this refusal exists for: `review-pr.mjs`'s own `confirm` step
    // already refuses a second ACCEPT on a `review:human` PR (we:skills-src/review/SKILL.md, "A
    // `review:human` PR is never agent-cleared"), so dispatching here can never land the contradicting
    // verdict #2588 lived. What IS owed is CONVERTING the superseded verdict into the standing advisory
    // note plus one targeted check on the escalation's own reason — never re-running the whole panel.
    // Checked ONLY for `needs-human`: a `needs-review` PR in this shape is the genuine #2588 race (no
    // escalation ever posted there — the label would have moved off `needs-review` the moment
    // `review:accepted` landed), so it keeps the ORIGINAL, unconditional refusal below.
    const conversion = withPhase?.phase === 'needs-human'
      ? planConvertSupersededVerdict({ headSha, reviewedSha, comments: pr?.comments })
      : { convert: false };
    if (conversion.convert) {
      // A targeted-check agent is a review emission too, so a required `review-gate` conflict still refuses it
      // (the early planner refusal no longer reaches a `needs-human` PR). Other required-check states are
      // deliberately NOT applied here: converting a superseded verdict never waited on CI (#xconv1).
      const convertCi = reviewCiGate({ headSha: pr?.headRefOid, requiredChecks, checks: pr?.statusCheckRollup });
      if (convertCi.reason === 'required-review-gate-conflict') {
        refuse('review-ci', {
          ...withPhase, ...extra, ci: convertCi,
          why: `${convertCi.reason}: ${convertCi.affected.map(row => `${row.name}=${row.reason}`).join(', ')}`,
        });
        return;
      }
      dispatch.push({
        ...base, ...withPhase, kind: 'convert-advisory', headSha, reviewedSha, ...extra,
        acceptComment: conversion.acceptComment, escalation: conversion.escalation,
        targetedCheckQuestion: targetedCheckQuestion(conversion.escalation),
        why: `this head (\`${headSha}\`) already completed an independent jury review, superseded by a ` +
          `later ${conversion.escalation.kind} escalation, not by any defect the panel found — convert ` +
          'that verdict into the standing advisory note (plus one targeted check on the escalation ' +
          'reason) instead of re-running the whole panel (#xconv1)',
      });
      return;
    }
    refuse('already-reviewed-head', {
      ...withPhase, headSha, reviewedSha, ...extra,
      why: `this exact head (\`${headSha}\`) already carries a \`reviewed-sha\` accept marker from a prior` +
        ' review — dispatching another review for a commit nobody has touched since risks a second,' +
        ' contradicting verdict landing on it (#2588)',
    });
    return;
  }
  // ── `no-findings` — refuse it (a fixer would invent work), but a review is still owed unless the review
  // population's own cap is spent.
  const findings = countFindings(pr?.comments);
  if (findings === 0) {
    refuse('no-findings', {
      ...withPhase, findings: 0, comments: Array.isArray(pr?.comments) ? pr.comments.length : 0, ...extra,
      why: 'no reviewer finding on this PR — a fix agent would invent work. A review, not a fix, is what an unreviewed PR is owed.',
    });
    if (attempts >= roundCap) {
      refuseCapExhausted({
        ...withPhase, attempts, cap: roundCap, findings: 0, capKind: 'review', ...extra,
        why: `no reviewer finding has ever landed on this PR, but its own durable attempt count is ${attempts}` +
          ` against a cap of ${roundCap} — a review keeps being dispatched with nothing to show for it, and a` +
          ' person must take it',
      });
    } else {
      if (!reviewChecksAllow({ pr, requiredChecks, refuse, withPhase, extra })) return;
      dispatch.push({
        ...base, ...withPhase, kind: 'review', findings: 0, attempts, ...extra,
        why: `parked for an independent review and no finding has been raised yet — a review is owed` +
          ` (#3279 runs it); ${attempts} of ${roundCap} attempts are spent`,
      });
    }
    return;
  }
  // ── the shared attempt cap, then the dispatch itself.
  if (attempts >= roundCap) {
    refuseCapExhausted({
      ...withPhase, attempts, cap: roundCap, capKind: 'review', ...extra,
      why: `the PR's own durable attempt count is ${attempts} against a cap of ${roundCap} — auto-repair is exhausted here and a person must take it`,
    });
    return;
  }
  if (!reviewChecksAllow({ pr, requiredChecks, refuse, withPhase, extra })) return;
  dispatch.push({
    ...base, ...withPhase, kind: 'review', findings, attempts, ...extra,
    why: `parked for an independent review with ${findings} finding(s) on the thread and nothing live working it`,
  });
}

// A canonical operator verdict is itself the durable grant. Anchor the allowance to
// the counters BEFORE that comment, never to the counters on the current tick.
// GitHub author metadata is required: copied attribution in an agent comment grants nothing.
function operatorFixBudget(comments, roundCap) {
  const thread = Array.isArray(comments) ? comments : [];
  for (let i = thread.length - 1; i >= 0; i--) {
    const c = thread[i];
    if (!isOperatorAuthored(c) || !c.id || typeof c.body !== 'string'
      || !Number.isFinite(Date.parse(c.createdAt))) continue;
    const login = c.author.login;
    const prefix = `🔁 review — changes requested\n\nRecorded by ${login}`;
    if (!c.body?.startsWith(prefix + '.') && !c.body?.startsWith(prefix + ' via ')) continue;
    const before = thread.slice(0, i);
    const baseline = Math.max(countRearmComments(before), countAdvisoryComments(before));
    const after = thread.slice(i + 1);
    const spent = Math.max(countRearmComments(after), countAdvisoryComments(after));
    return { verdictId: c.id, cap: Math.max(roundCap, baseline + 2), attempts: baseline + spent };
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
 *   `alreadyLandedInMain` (optional, `{carrierPr:(number|null)}`) is the ALREADY-LANDED verdict (live incident
 *   PR #2752) computed by the IO shell's per-file blob-identity check against `main`'s own history; its absence
 *   means every PR falls through unaffected, exactly as before this branch existed.
 * @param {Array<object>} [o.agents] - `claude agents --json` entries, each optionally carrying the two facts the
 *   listing cannot supply and the IO shell resolves: `laneHeadOid` (the `HEAD` of the lane at `cwd`) and
 *   `pidAlive` (`process.kill(pid, 0)` → `true`/`false`; absent = not probed = UNKNOWN).
 * @param {object} [o.durableCounts] - `{ [prNumber]: n }`, the PR-derived attempt count the shell reads back
 *   with `countRearmComments`. There is NO in-process tally parameter and none is consulted: a cap that a
 *   restart can reset is not a cap.
 * @param {number} [o.now] - epoch ms, used ONLY to age the surfaced permission-block notes. No decision reads it,
 *   so the plan for a given input is stable over time — a `stood-down` PR returns an identical result a week on.
 *   (we:backlog/4352 exception: {@link acceptLabelDropped}'s grace window reads it; `0` keeps that check off.)
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
 * @param {Array<{start:string, end:(string|null)}>} [o.mainRedWindows] - we:backlog/x5uqim1-*.md: the repo's
 *   `main`'s own red-CI windows (`we:scripts/conveyor/main-red-recovery.mjs#computeMainRedWindows`), read by
 *   the IO shell from `gh run list --branch <defaultBranch>` ONLY when at least one PR is `ci-red` (never paid
 *   for otherwise). Defaults to `[]` — a caller that never reads `main`'s own history sees byte-identical
 *   behaviour to before this param existed (every `ci-red` PR falls straight through to the `ci-heal` path).
 * @param {Array<object>} [o.mainLatestCheckRuns] - landing-freeze fix (2026-09-27): `main`'s own latest completed
 *   run's per-check conclusions (`we:scripts/conveyor/reconcile-pass.mjs#defaultReadMainLatestCheckRuns`), read
 *   by the IO shell under the SAME "only when at least one PR is `ci-red`" gate as `mainRedWindows`. Lets
 *   `isPrCiFailureOwedRerun` excuse a failure `mainRedWindows` alone can never explain — a required check that
 *   never even RAN on `main` during its own regression window (PR #2790's own incident: `daemon-soak` was
 *   `pull_request`-only before it, so `main`'s CI runs stayed `success` right through a real `daemon-soak`
 *   regression — no red window ever opened to attribute against). Defaults to `[]` — a caller that never reads
 *   it sees byte-identical behaviour to before this param existed.
 * @param {number} [o.liveSessionOverrunMs] - see {@link LIVE_SESSION_OVERRUN_MS}'s own docblock; defaults to it.
 * @returns {{dispatch:Array<object>, refusals:Array<object>, notes:Array<object>}}
 */
/**
 * we:scripts/conveyor/reconcile-core.mjs#roundCapExhaustedNoteText — xilx617 (epic #4075/#3383): the STABLE text
 * for a `round-cap-exhausted` note. No clock-derived number (unlike `ci-heal-exhausted`'s `heldHours`, which is
 * explicitly EVIDENCE for a still-open block, not an identity) — `attempts`/`cap`/`capKind` are the only inputs,
 * all durable, so the SAME episode reads identically on every tick until the durable count itself advances.
 * @param {number} prNumber
 * @param {number} attempts
 * @param {number} cap
 * @param {string} capKind
 * @returns {string}
 */
function roundCapExhaustedNoteText(prNumber, attempts, cap, capKind) {
  return `PR #${prNumber}: ${capKind} auto-repair rounds exhausted (${attempts}/${cap}) — a person must take it over`;
}

/** How long a PR must have been green and still label-less before `restore-review-label` fires: a producer
 *  (`pr-land --label-on-green`) labels `ready-to-merge` within seconds of green, and must not race a daemon-added
 *  `review:pending` that would hold an auto-landing PR for a review it does not need. */
export const RESTORE_REVIEW_LABEL_GRACE_MS = 10 * 60_000;

/** True when the newest completed check finished at least the grace ago (or no timestamp is readable). */
export function greenSettledForRestoreGrace(rollup, now, graceMs = RESTORE_REVIEW_LABEL_GRACE_MS) {
  const times = (Array.isArray(rollup) ? rollup : []).map((c) => Date.parse(c?.completedAt)).filter(Number.isFinite);
  if (!times.length || !Number.isFinite(now) || !now) return true;
  return now - Math.max(...times) >= graceMs;
}

/** Tri-state diagnostic: unknown evidence is never an empty review family. */
export function missingReviewLabel(pr) {
  if (!pr || pr.state !== 'OPEN' || !Array.isArray(pr.labels)
    || !pr.labels.every(l => typeof (typeof l === 'string' ? l : l?.name) === 'string' && (typeof l === 'string' ? l : l.name).length > 0)
    || !Array.isArray(pr.commits)) return null;
  return isAiGeneratedPr(pr) && !pr.labels.some(l => (typeof l === 'string' ? l : l.name).startsWith('review:'));
}

export function planReconcile({
  repo = 'we', prs = [], agents = [], durableCounts = {}, now = 0, roundCap = NEGOTIATION_ROUND_CAP, ciHealCap = CI_HEAL_ROUND_CAP,
  conflictFixCap = CONFLICT_FIX_ROUND_CAP, advisoryFixCap = ADVISORY_FIX_ROUND_CAP, defaultBranch = 'main',
  mainRedWindows = [], mainLatestCheckRuns = [],
  // #2748 false-red follow-up (soak-replay-gate, PR #2775) — the repo's REQUIRED status-check names (branch
  // protection, `we:scripts/lib/required-status-checks.mjs`), threaded straight through to `classifyPr` so
  // `ci-red` means a REQUIRED check failed, not merely "a check outside the hand-maintained exclusion list".
  // Optional and pure DATA IN: this file stays IO-free, so the caller (`we:scripts/conveyor/reconcile-pass.mjs`)
  // is the one that fetches (and caches) the live set; omitted, `classifyPr` falls back to its own exclusion-
  // list default unchanged — byte-identical behaviour to before this param existed.
  requiredChecks = null,
  // xilx617 (epic #4075/#3383) — the bound a `live-process` refusal must overrun before it also gets a
  // surfaced `session-overrun` note (see {@link LIVE_SESSION_OVERRUN_MS}'s own docblock). A `planReconcile`
  // OPTION, never an env read — this file stays pure; a test sets it directly to exercise both sides of the
  // bound with no clock mocking.
  liveSessionOverrunMs = LIVE_SESSION_OVERRUN_MS,
  // #2787-live-incident (2026-09-27) — `origin/<defaultBranch>`'s own current tip, a CHEAP, purely-local fact
  // (`reconcile-pass.mjs`'s IO shell resolves it with one `git rev-parse`, piggybacked on the fetch
  // `assertMainNotStale` already ran this same tick — no extra `gh` call, no GraphQL/REST budget exposure).
  // `null` (the default, and what every existing test/caller gets unless it opts in) degrades the staleness
  // comparison below to ref-name-only — see {@link countStaleConflictFixRounds}'s own docblock.
  mainSha = null,
} = {}) {
  const dispatch = [];
  const refusals = [];
  const notes = [];
  const counts = durableCounts && typeof durableCounts === 'object' ? durableCounts : {};

  for (const pr of Array.isArray(prs) ? prs : []) {
    const prNumber = Number(pr?.number);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue; // not a PR record; nothing to key on.

    if (missingReviewLabel(pr) === true) notes.push({ kind: 'review-label-missing', prNumber, repo, text: 'open agent PR has no review:* label' });

    // The evidence every row carries, so a reader never has to go back to the listing to audit a verdict.
    const operatorAnswer = latestOperatorAnswer(pr?.comments);
    const operatorBudget = operatorFixBudget(pr?.comments, roundCap);
    const effectiveRoundCap = operatorBudget?.cap ?? roundCap;
    const base = {
      ...(operatorBudget ? { operatorFixBudget: operatorBudget } : {}),
      ...(operatorAnswer ? { operatorAnswer } : {}),
      prNumber,
      headRefName: pr?.headRefName ?? null,
      headRefOid: pr?.headRefOid ?? null,
      // #3383 — carried on every row (evidence, mirrors `transcriptMtimeMs`/`body` just below): the STACKED-BASE
      // CONFLICT branch reads it, and a reader auditing any other row can see at a glance whether this PR is
      // stacked on another lane/PR at all, with no need to go back to the raw listing.
      baseRefName: pr?.baseRefName ?? null,
      // #4265 — the STACKED-BASE CONFLICT branch's own `currentSha` for {@link countStaleConflictFixRounds},
      // mirroring `mainSha` for the main-base branch (both resolved PURELY LOCALLY by `reconcile-pass.mjs`'s IO
      // shell — this file stays IO-free). `null` for a PR whose base is `defaultBranch` (or unknown) — the
      // stacked-base branch never reads it there, and every existing test/caller that omits it degrades to the
      // pre-#4265 ref-only comparison, unchanged.
      baseRefSha: pr?.baseRefSha ?? null,
      // EVIDENCE ONLY. No decision in this file reads it — see the liveness block in the file docblock.
      transcriptMtimeMs: Number.isFinite(pr?.transcriptMtimeMs) ? pr.transcriptMtimeMs : null,
      // #xu2krte Fork 1 — carried on every row (not just `fix` dispatches) for the same "evidence travels with
      // the row" reason `transcriptMtimeMs` does. `reconcile-fix-dispatch.mjs` reads the `authored-by-actor`
      // stamp off it, ONLY for a `fix` dispatch that also carries the `merge-status:conflicting` label.
      body: typeof pr?.body === 'string' ? pr.body : null,
      // we:backlog/x5uqim1-*.md — the two facts `isPrCiFailureOwedRerun` needs, injected by the IO shell ONLY
      // for a PR whose required check is currently failing (reconcile-pass.mjs never pays for these reads on a
      // PR with nothing red). EVIDENCE ONLY here; the `ci-red` branch below is the one decision that reads them.
      // `aheadByOnMain` is `main`'s own current tip's `ahead_by` against this PR's head (0 once it already
      // contains that tip) — REPLACES an earlier `requiredCheckAttempt` design, corrected mid-build: see
      // `main-red-recovery.mjs`'s own file header for why a GitHub Actions rerun of the same stale commit does
      // not actually resolve a red-main-caused failure, live-measured on this exact incident.
      requiredCheckCompletedAt: pr?.requiredCheckCompletedAt ?? null,
      aheadByOnMain: Number.isFinite(pr?.aheadByOnMain) ? pr.aheadByOnMain : null,
      // landing-freeze fix (2026-09-27) — WHICH required check is the one currently failing (`reconcile-
      // pass.mjs#enrichPrsWithMainRedFacts`'s own `failingRequiredCheckForAttribution` result), so the `ci-red`
      // branch below can ask `isMainGreenFixOwed` about THIS SAME check on main's own latest completed run,
      // never a different one. EVIDENCE ONLY here, same as its two siblings above.
      requiredCheckName: pr?.requiredCheckName ?? null,
      // #4263 — EVIDENCE ONLY here, same convention as its siblings: whether the fix PR a `waiting-on-
      // system-fix` ci-heal escalation named has since merged/closed, re-checked (never trusted from the
      // escalation comment's own stale claim) by `reconcile-pass.mjs#enrichPrsWithSystemFixFacts`. Only the
      // ci-red escalation branch below reads it.
      systemFixLanded: pr?.systemFixLanded === true,
      // PR #2793 review — the per-PR proof the green-check path needs (`main-red-recovery.mjs#isMainGreenFixOwed`):
      // does this PR already contain main's latest green commit for that check, and what did the check conclude
      // at this PR's merge base with it. EVIDENCE ONLY, injected by the IO shell; absent reads never excuse.
      prContainsMainGreenSha: typeof pr?.prContainsMainGreenSha === 'boolean' ? pr.prContainsMainGreenSha : null,
      mergeBaseCheckRuns: Array.isArray(pr?.mergeBaseCheckRuns) ? pr.mergeBaseCheckRuns : null,
      mergeBaseRunConclusion: typeof pr?.mergeBaseRunConclusion === 'string' ? pr.mergeBaseRunConclusion : null,
      // #x9fbg1x-live-incident (2026-09-27) — the PR's OWN already-changed files, when the IO shell's `gh pr
      // list` read carried them (`reconcile-pass.mjs#PR_LIST_JSON_FIELDS` now asks for `files`, served for free
      // off the shared `#gh-graphql-budget` snapshot — see `pr-snapshot.mjs#SNAPSHOT_FIELDS`, which already
      // fetches this for every open PR). EVIDENCE ONLY here (no decision in THIS file reads it — mirrors
      // `aheadByOnMain`/`body` above); `reconcile-fix-dispatch.mjs#planFixesFromReconcile` reads it so a
      // no-declared-scope fix dispatch can fence itself off this PR's real changed files WITHOUT a second,
      // rate-limit-exposed `gh pr diff` call of its own. Projected to plain repo-relative path strings (the
      // same shape `fetchDiffPaths` already returns) right here at the pure core's boundary, not left as raw
      // `{path, additions, deletions}` objects for every consumer to re-derive. `null` (not `[]`) when the
      // shell's own read did not carry `files` at all (an older caller, or a `--prs-file` snapshot built before
      // this field existed) — a caller must tell "not fetched" apart from "genuinely no files changed".
      // gh's GraphQL files connection stops at 100: force a full diff read at the cap.
      files: Array.isArray(pr?.files) && pr.files.length < 100
        ? pr.files.map((f) => (typeof f?.path === 'string' ? f.path : String(f ?? ''))).filter(Boolean)
        : null,
    };
    const refuse = (kind, extra) => { refusals.push({ ...base, kind, ...extra }); };
    // xilx617 (epic #4075/#3383) — EVERY `cap-exhausted` refusal EXCEPT the `ci-red` one above (which already
    // pushes its own `ci-heal-exhausted` note) also pushes a `round-cap-exhausted` note, mirroring that note's
    // own "refuse AND surface" treatment. `capKind` names the population; see {@link roundCapExhaustedNoteText}
    // for why the text carries no clock-derived number.
    // Built over an injected `refuseFn` so the ci-red-parallel review (below) can fold its `cap-exhausted` into
    // the PR's one `owed-ci-rerun` row while still surfacing the SAME note.
    const capExhaustedVia = (refuseFn) => (extra) => {
      refuseFn('cap-exhausted', extra);
      notes.push({
        kind: 'round-cap-exhausted', prNumber, attempts: extra.attempts, cap: extra.cap, capKind: extra.capKind,
        text: roundCapExhaustedNoteText(prNumber, extra.attempts, extra.cap, extra.capKind),
      });
    };
    const refuseCapExhausted = capExhaustedVia(refuse);
    // The shared round count — see REFUSAL 3 below for why it is a `Math.max` over three durable sources.
    const roundAttempts = () => Math.max(
      Number(counts[prNumber]) || 0,
      operatorBudget?.attempts ?? 0,
      countRearmComments(pr?.comments),
      countAdvisoryComments(pr?.comments),
    );

    // ── REFUSAL 1 — `stood-down` is TERMINAL. No decay, no clock: `now` is not read on this path, so the same
    // PR returns the same refusal a week later unless an operator answer or supersede resolves it.
    //
    // `countUnresolvedStandDowns`, NOT the raw stand-down count — #xu2krte Fork 2 (review-human statute
    // amendment), the advisory-mechanism supersede, and the explicit operator-answer ceremony. Three independent
    // predicates exclude provably resolved stand-downs:
    //   - `isOperatorAnswerStandDownSuperseded` — a trusted operator ceremony answers this exact comment.
    //   - `isStandDownSuperseded` — a parked-PR conflict watch stand-down the watch ITSELF later re-classified
    //     safe, evidenced by a LATER, self-authored supersede comment on the thread.
    //   - `isAdvisoryMechanismStandDownSuperseded` (xaer296) — a fix agent's OWN "cannot reproduce" stand-down
    //     in ADVISORY-FIX MODE, where the thread already proves (an earlier, self-authored advisory-fix mark
    //     postdating the latest advisory note) that there was genuinely nothing left to fix — a mechanism
    //     failure (the old count-based "is this addressed" test never caught up), not a real judgment call.
    // The two automation supersedes require the comment's OWN `author.login` (or GitHub's `viewerDidAuthor`, kept as an additional
    // accepted path) to match this repo's own automation — never a body substring anyone could forge.
    // `viewerDidAuthor` ALONE is not READ-stable enough here — see `stand-down.mjs#AUTOMATION_LOGINS`'s own
    // docblock for the live incident that proved it. Operator answers require a trusted login, never viewerDidAuthor alone.
    // A stand-down none of these predicates excludes — including an unanswered fix agent's genuine
    // needs-judgment/gate-red/lane-ref-gone escalation outside the advisory-fix shape above, and any human
    // `/finish` stand-down — stays terminal exactly as before.
    const stoodDown = countUnresolvedStandDowns(pr?.comments);
    if (stoodDown > 0) {
      refuse('stood-down', {
        standDowns: stoodDown,
        why: 'a fix agent already stopped here to ask a question — re-dispatching would re-ask it forever. Terminal until an explicit operator answer is recorded with stand-down-answer.mjs.',
      });
      continue;
    }

    // ── REFUSAL 1b — fix procedure (operator-approved 2026-09-27, live incident PR #2811): a LIVE fix claim
    // (`we:scripts/conveyor/fix-procedure.mjs`) means one author owns this PR's repair right now. NOTHING is
    // dispatched — not a review or advisory (the head is about to change), not a second fixer or ci-heal (two
    // authors on one lane is the incident), not `promote-draft` (the green CI belongs to the head being
    // replaced). EVIDENCE ONLY in `pr.fixClaim`, attached by the IO shell (`reconcile-pass.mjs
    // #enrichPrsWithFixClaims`) from the claim store; a crashed holder's claim expires on its TTL and this
    // refusal simply stops firing.
    if (pr?.fixClaim && pr.fixClaim.who) {
      refuse('fix-claimed', {
        who: pr.fixClaim.who, since: pr.fixClaim.claimedAt ?? null,
        why: `${pr.fixClaim.who} holds the fix claim${pr.fixClaim.why ? ` (${pr.fixClaim.why})` : ''} — nothing is dispatched until its fix-end`,
      });
      continue;
    }

    // ── #3850 — an operator DISPOSITION (stand-down-answer-core.mjs#answerDisposition) is executed by the
    // conveyor, never handed to a fixer: fix-3850 read "close as superseded" as "delete the card's files", was
    // denied, and ended blocked-on-infra with the PR still open. Checked after the live-claim refusal (never
    // close a PR under a running fixer) and before every repair branch.
    if (pr?.state === 'OPEN' && answerDisposition(operatorAnswer) === 'close-superseded') {
      dispatch.push({
        ...base, kind: 'close-superseded',
        why: `the operator ruled this PR superseded (@${operatorAnswer.actor} via ${operatorAnswer.channel}) — close it, no fix agent`,
      });
      continue;
    }

    // ── REFUSAL 1c — a concurrent-author PAUSE (new-style, or a legacy stand-down reclassified by
    // `countUnresolvedStandDowns` above). Held only until the head moves or goes quiet; after that the PR
    // falls through as re-armed, and every row carries the saved alt branch so the next fixer starts from it.
    const pauseState = concurrentAuthorPauseState({ comments: pr?.comments, headRefOid: pr?.headRefOid ?? null, now });
    if (pauseState?.held) {
      refuse('concurrent-author-paused', { altBranch: pauseState.pause.alt ?? null, why: pauseState.why });
      continue;
    }
    if (pauseState?.pause?.alt) {
      base.altBranch = pauseState.pause.alt;
      base.rearmed = pauseState.why;
    }

    // ── REFUSAL 4 — liveness, from a live process. The binding is derived and its evidence travels with the
    // refusal, because the derivation itself has been observed to be wrong (#3283).
    const bound = bindAgents(pr, agents, repo);

    // xilx617 (epic #4075/#3383) — the durable per-session infra-retry streak, surfaced independently of
    // whatever `assessLiveness` below returns (a capped session may already read `selfReportedDone` — finished,
    // free to redispatch — by the time the cool-off elapses, which would otherwise never reach this note at
    // all). Checked on the RAW `bound` list, not the post-`isFinished`-filter one `assessLiveness` uses
    // internally, for exactly that reason. Episode key is `kind + prNumber + since` (see
    // `reconcile-note-comment.mjs#noteEpisodeKey`) — deliberately NOT `streak`, so a streak that keeps growing
    // past the cap (infra never recovers) still posts as ONE episode, not a fresh comment every tick.
    const infraCapped = bound.find((b) => b.agent?.infraStreakCapped === true);
    if (infraCapped) {
      const streak = Number.isInteger(infraCapped.agent.infraStreak) ? infraCapped.agent.infraStreak : INFRA_RETRY_CAP;
      const since = infraCapped.agent.infraStreakSince ?? null;
      notes.push({
        kind: 'infra-retry-exhausted', prNumber, streak, cap: INFRA_RETRY_CAP, since,
        text: `PR #${prNumber}: blocked-on-infra retry streak reached the cap (${INFRA_RETRY_CAP}) — auto-retry`
          + ' continues with a longer cool-off, but a person should check whether the infra issue is real',
      });
    }

    const live = assessLiveness(bound);
    if (live) {
      refuse(live.kind, {
        pid: live.pid, cwd: live.cwd, sha: live.sha, sessionId: live.sessionId, why: live.why,
        ...(live.waitingFor ? { waitingFor: live.waitingFor, startedAt: live.startedAt } : {}),
        // #x9fbg1x — the MORE SPECIFIC reason, when `markBgIsolationStalls` confirmed one; never present
        // otherwise, so an ordinary `awaiting-permission` refusal is byte-identical to before this existed.
        ...(live.stallReason ? { stallReason: live.stallReason } : {}),
      });
      // The permission block is the case that must never be merely refused. Three sessions have held one for
      // 211.4 hours; a refusal buried in a list is how that stayed invisible. It gets its own surfaced note.
      if (live.kind === 'awaiting-permission') {
        const startedMs = startedAtMs(live.startedAt);
        const heldHours = Number.isFinite(startedMs) && now ? Math.round(((now - startedMs) / 3_600_000) * 10) / 10 : null;
        notes.push({
          kind: 'awaiting-permission', prNumber, pid: live.pid, cwd: live.cwd, sessionId: live.sessionId,
          waitingFor: live.waitingFor, startedAt: live.startedAt, heldHours,
          ...(live.stallReason ? { stallReason: live.stallReason } : {}),
          text: `PR #${prNumber}: a session in ${live.cwd} is blocked on "${live.waitingFor}"`
            + `${heldHours == null ? '' : ` for ${heldHours}h`} and nobody is there to answer it — nothing here will advance until a person clears it`
            + (live.stallReason === 'bg-isolation-stall' ? ' (confirmed: Claude Code\'s own EnterWorktree/bgIsolation guard — see we:scripts/lib/dispatch-bg-isolation.mjs)' : ''),
        });
      }
      // xilx617 (epic #4075/#3383) — a LIVE session (never `awaiting-permission`, which already notes above)
      // still working a PR past `liveSessionOverrunMs` also gets a surfaced note. STILL REFUSES — this never
      // kills or reaps the session, mirroring `awaiting-permission`'s own "refuse AND surface" shape. The bound
      // is stated in the text, never the elapsed time, so the SAME episode (keyed on `sessionId`/`pid`, see
      // `noteEpisodeKey`) reads identically on every later tick.
      if (live.kind === 'live-process') {
        const startedMs = startedAtMs(live.startedAt);
        if (Number.isFinite(startedMs) && now && (now - startedMs) >= liveSessionOverrunMs) {
          const boundMin = Math.round(liveSessionOverrunMs / 60_000);
          notes.push({
            kind: 'session-overrun', prNumber, sessionId: live.sessionId, pid: live.pid, startedAt: live.startedAt, boundMin,
            text: `PR #${prNumber}: a session (${live.sessionId ?? live.pid ?? 'unknown'}) has been live past the`
              + ` ${boundMin}-minute bound — still refusing to dispatch a second agent, but a person should check whether it is stuck`,
          });
        }
      }
      continue;
    }

    // ── PHASE, BORROWED. `classifyPr` for the labels, `reduceCheckState` for CI truth. Not re-derived.
    const phase = classifyPr({
      state: pr?.state, labels: pr?.labels, mergeStateStatus: pr?.mergeStateStatus,
      statusCheckRollup: pr?.statusCheckRollup,
    }, requiredChecks);
    const check = reduceCheckState(pr?.statusCheckRollup, requiredChecks);
    const withPhase = { phase, check: check.state, labels: labelNames(pr?.labels) };

    // ── ALREADY-LANDED — its OWN branch, AHEAD OF EVERY OTHER CHECK IN THIS LOOP (`ci-red`, the advisory-fix
    // branch, STACKED-BASE, the generic `OWED` table — every one of them would otherwise dispatch a fixer or a
    // reviewer at a PR with nothing left to change). Live incident, web-everything/web-everything PR #2752: bounced
    // (`review:changes`) AND `merge-status:conflicting`, which — unchecked — hits `isConflictBounce` below and
    // dispatches a mechanical conflict-fix. But every file it touches is already, byte-for-byte, on `main`
    // (carried there by PR #2759, which stacked on #2752's branch and merged first); a fixer would find nothing
    // to repair, and one asked to "resolve the conflict" could revert the carrier PR's later work instead. The
    // verdict (`pr.alreadyLandedInMain`) is computed by the IO shell from PER-FILE BLOB IDENTITY against `main`'s
    // own commit history — see `we:scripts/lib/already-landed-content.mjs`'s own header for why that signal, and
    // not a plain `merge-tree`/current-content diff, is what survives a rebase plus later refinement on `main`.
    // Checked ahead of liveness-derived phase branching but AFTER `stood-down`/liveness themselves (REFUSALS 1
    // and 4 above) — a PR a human has already stood down on, or one a live session is genuinely working, still
    // takes priority over this one; this only pre-empts dispatching FRESH work at an already-landed PR.
    if (pr?.alreadyLandedInMain) {
      const carrierPr = pr.alreadyLandedInMain.carrierPr ?? null;
      refuse('already-landed', {
        ...withPhase, carrierPr,
        why: carrierPr
          ? `every file this PR touches is already byte-identical to a commit on \`${defaultBranch}\` — carried` +
            ` there by #${carrierPr}, which merged first while this PR's own branch was separately rebased.` +
            ' Nothing to fix or review; it should be closed and its backlog card resolved, never dispatched.'
          : `every file this PR touches is already byte-identical to a commit on \`${defaultBranch}\`, though the` +
            ' PR that carried it there could not be attributed with confidence. Nothing to fix or review; it' +
            ' should be closed and its backlog card resolved, never dispatched.',
      });
      continue;
    }

    // ── `promote-draft` (draft-first PRs, operator-approved 2026-09-27) — its OWN branch, ahead of `ci-red`
    // and everything below it, for a draft PR whose required checks are ALL green (`withPhase.check ===
    // 'green'`, the SAME `reduceCheckState` verdict the `ci-red` branch right below reads off this identical
    // PR). A green draft owes exactly one thing — `gh pr ready`, dispatched here as `kind:'promote-draft'` —
    // and nothing else this loop could plan (a review, a fix, a ci-heal) applies to it: `ci-red` cannot also
    // be true (checks are green), and {@link dispatchReviewRow}'s own `isDraft` gate would refuse a review
    // dispatch for it anyway. `continue` is therefore exactly as safe here as it is on `already-landed` above.
    //
    // A draft PR whose checks are NOT yet green (`pending`/`unchecked`) or ARE red falls straight through,
    // deliberately: red-required-check drafts still need `ci-heal` exactly like a ready PR does (a draft is
    // not exempt from CI healing — only from review), and a still-running draft owes nothing at all yet — both
    // of those are the existing branches below, unmodified. Only {@link dispatchReviewRow}'s own gate (not this
    // one) keeps a review from firing for either of those two cases.
    if (pr?.isDraft && withPhase.check === 'green') {
      if (labelNames(pr.labels).includes('review-status:draft-withdrawn')) {
        refuse('draft', { ...withPhase, why: 'draft PR is withdrawn — explicit release is required before promotion' });
        continue;
      }
      dispatch.push({
        ...base, ...withPhase, kind: 'promote-draft',
        why: 'draft PR — every required check is green; promote it to ready for review (draft-first PRs, '
          + 'operator-approved 2026-09-27) — nothing else is owed this PR until that happens',
      });
      continue;
    }

    // ── `restore-review-label` (LIVE INCIDENT 2026-10-03/04, PR #3830 — an approval-time prevention-card PR) —
    // an OPEN, GREEN, non-draft `lane/*` PR carrying NO `review:*` label (and no `ready-to-merge` landing-gate
    // label either) is in limbo forever: `classifyPr` reads phase `open` ("no hold recorded"), the generic table
    // answers `nothing-owed`, and no daemon ever owns it. The producer (`pr-land --label-on-green`) exits
    // WITHOUT any label when its green-wait ends red/timeout/behind, and the fix daemon later heals the red —
    // leaving a green PR nobody labelled. Owed here: the neutral hand-off label `review:pending`, applied by the
    // promote-draft pass's sibling half (`promote-draft-pr-dispatch.mjs`), so the ordinary review path owns it.
    // Deliberately NOT gated on AI authorship (the commit list of a drain-rebased lane carries merge commits
    // from other authors, which made `missingReviewLabel` read false on #3830 itself).
    if (phase === 'open' && !pr?.isDraft && withPhase.check === 'green'
        && String(pr?.headRefName ?? '').startsWith('lane/')
        && !withPhase.labels.some((l) => l.startsWith('review:') || l === 'ready-to-merge')
        && greenSettledForRestoreGrace(pr?.statusCheckRollup, now)) {
      dispatch.push({
        ...base, ...withPhase, kind: 'restore-review-label', label: 'review:pending',
        why: 'open lane PR, every required check is green, and it carries no review:* (or ready-to-merge) label — '
          + 'nothing would ever own it; apply review:pending so the ordinary review path picks it up',
      });
      continue;
    }

    // A required `review-gate` is red by design while a review label is held, so a `ci-red` PR whose ONLY
    // failing required check is `review-gate` must not be healed (ci-heal cannot clear it; it would re-run
    // every tick). Deliberately narrow: only the `ci-red` phase, and only when `review-gate` is the sole
    // affected check. Any other failing required check, and every non-`ci-red` phase (a bounced PR owed a
    // fixer, an advisory-fix PR), falls through so its repair ownership is intact; review emission is
    // already gated separately by {@link reviewChecksAllow}.
    const reviewCi = reviewCiGate({ headSha: pr?.headRefOid, requiredChecks, checks: pr?.statusCheckRollup });
    // LIVE INCIDENT 2026-10-04, PR #3833: `classifyPr` ranks `review:human` ('needs-human') ABOVE `ci-red`, so a
    // `review:human` PR with a genuinely red required check never entered the `ci-red` branch below — the
    // main-red watch logged "owed a ci-heal" and the review row logged `review-ci`, and NOBODY planned the heal
    // (9 h, zero dispatches). A CI repair is not a review decision: ci-heal never touches a `review:*` label, so
    // the human hold must not exclude it. Only a COMPLETED red (`check.state === 'red'`) opts a needs-human PR in —
    // pending/unchecked stay with the review path exactly as before.
    const ciRepairOwed = phase === 'ci-red' || (phase === 'needs-human' && check.state === 'red');
    if (ciRepairOwed && reviewCi.reason === 'required-review-gate-conflict'
        && reviewCi.affected.every(row => row.name === 'review-gate')) {
      refuse('review-ci', { ...withPhase, ci: reviewCi, why: 'required review-gate must succeed before review; resolve the review-dependent required-check configuration' });
      continue;
    }

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
    if (ciRepairOwed) {
      // we:backlog/x9wz0ir-*.md (#4075/#3383) — LIVE INCIDENT 2026-09-25: PRs #2635/#2636 are BOTH `owed-ci-
      // rerun` (their required check failed inside one of `main`'s own red windows) AND `mergeStateStatus:
      // 'DIRTY'` (real conflicts with `main`, confirmed live via `gh pr view --json mergeStateStatus,mergeable`
      // → `DIRTY`/`CONFLICTING` for both). `owed-ci-rerun`'s whole premise is "a MECHANICAL rebase onto main
      // clears this" (`ci-red-recovery-watch.mjs#planMainRedRebases`'s own `rebase-onto-main` dispatch, via
      // `rebaseDropManifest`) — that premise is FALSE for a DIRTY PR: a no-checkout rebase cannot resolve a
      // real conflict, so refusing `owed-ci-rerun` here left these two PRs stuck forever (no rebase watch can
      // ever clear them, and this refusal pre-empted the only OTHER path — `ci-heal`, which DOES rebase/merge
      // main AND resolve the conflict — from ever being planned for them). `merge === 'DIRTY'` is read straight
      // off `pr.mergeStateStatus`, the SAME field `classifyPr` above already reads for the `conflicted` phase;
      // it just never gets there for a PR whose checks are ALSO failing, since `classifyPr`'s `ci-red` check
      // runs first (see that function's own precedence). Skipping `owed-ci-rerun` for a DIRTY PR falls straight
      // through to the ordinary `ci-heal` cap-check/dispatch below — the correct owner once a mechanical rebase
      // cannot possibly succeed.
      const mergeDirty = String(pr?.mergeStateStatus ?? '').toUpperCase() === 'DIRTY';
      // x5uqim1 follow-up (#4075/#3383), 2026-09-25 18:55 ET: `owed-ci-rerun`'s whole premise is "a MECHANICAL
      // rebase clears this" — which is no longer true once that rebase has already been tried and capped
      // against this exact head sha (`we:scripts/conveyor/main-red-recovery.mjs#countRebaseOntoMainComments`,
      // counted straight off `pr.comments` — already part of this pass's own input, no new IO shell wiring
      // needed). Read the SAME way `mergeDirty` above is: a fact about THIS pr object, not a re-derivation.
      // Without this, a rebase that keeps failing for a non-conflict reason (a push race, a transient `gh`
      // error — a REAL conflict already escapes via `mergeDirty` above) would have refused `owed-ci-rerun`
      // forever, since `isPrCiFailureOwedRerun` itself has no notion of "already tried and gave up".
      const rebaseCapExhausted = countRebaseOntoMainComments(pr?.comments, pr?.headRefOid) >= DEFAULT_MAX_REBASE_RETRIES_PER_SHA;
      // we:backlog/x5uqim1-*.md — LIVE INCIDENT 2026-09-25 (see `main-red-recovery.mjs`'s own header for the
      // full measured shape): a required check that failed only because `main`'s own CI was red at that moment
      // is not this PR's own defect. Checked BEFORE the `ci-heal` cap below (and skips it entirely) — this is
      // not one more round spent against that cap, it is a DIFFERENT job this pass does not run itself
      // (`we:scripts/conveyor/ci-red-recovery-watch.mjs` does), the same "owed elsewhere, never dispatched
      // here" shape `OWED_ELSEWHERE` already uses for a `conflicted` PR.
      // landing-freeze fix (2026-09-27) — LIVE INCIDENT: PR #2790 fixed a `daemon-soak` regression that had sat
      // on `main` unseen (the job was `pull_request`-only before it, so `main`'s own CI runs stayed `success`
      // right through the regression — no red window ever opened to attribute against retroactively), leaving
      // #2748/#2783/#2784 `cap-exhausted` and #2788/#2789 about to be handed yet another `ci-heal` for code that
      // was never broken. `isPrCiFailureOwedRerun`'s new green-check path (see its own docblock) catches exactly
      // this: `requiredCheckName` now passes on main's own latest completed run, independent of any red-window
      // attribution. Checked in the SAME call, BEFORE the `ci-heal` cap below, exactly like the red-window path —
      // a PR already sitting `cap-exhausted` from burning its heal count on main's own now-fixed regression is
      // NOT re-capped or specially reset: the cap is simply never consulted on this path, so the very next tick
      // this fires it reads `owed-ci-rerun` instead, with no separate "re-arm" bookkeeping needed.
      if (!mergeDirty && !rebaseCapExhausted && isPrCiFailureOwedRerun({
        comments: pr?.comments, headSha: pr?.headRefOid,
        requiredCheckCompletedAt: base.requiredCheckCompletedAt,
        aheadBy: base.aheadByOnMain,
        mainRedWindows,
        failingCheckName: base.requiredCheckName,
        mainLatestCheckRuns,
        prContainsMainGreenSha: base.prContainsMainGreenSha,
        mergeBaseCheckRuns: base.mergeBaseCheckRuns,
        mergeBaseRunConclusion: base.mergeBaseRunConclusion,
      })) {
        const viaMainGreen = classifyCiFailureAttribution({
          failureCompletedAt: base.requiredCheckCompletedAt, mainRedWindows,
        }) !== 'main-red';
        refuse('owed-ci-rerun', {
          ...withPhase,
          why: viaMainGreen
            ? `the required check \`${base.requiredCheckName}\` failed at ${base.requiredCheckCompletedAt}, but is passing on main's own latest completed run — main has since fixed this, this PR's own code is not implicated. It is owed a mechanical rebase onto main (scripts/conveyor/ci-red-recovery-watch.mjs), never a ci-heal, which would misdiagnose main's own (now-fixed) breakage as a defect here`
            : `the required check failed at ${base.requiredCheckCompletedAt}, while main's own CI was red — this PR's own code is not implicated. It is owed a mechanical rebase onto main (scripts/conveyor/ci-red-recovery-watch.mjs) once main has recovered, never a ci-heal, which would misdiagnose main's own breakage as a defect here`,
        });
        // Preserve rerun ownership while folding the independent review prerequisite into this
        // same refusal row. Required checks must succeed even when their failure belongs to main.
        if (withPhase.labels.includes('review:pending')) {
          const foldRefusal = foldReviewRefusalInto(refusals[refusals.length - 1], withPhase, 'owedCiRerun');
          dispatchReviewRow({
            pr, requiredChecks, withPhase, base, attempts: roundAttempts(), roundCap: effectiveRoundCap, now,
            refuse: foldRefusal, refuseCapExhausted: capExhaustedVia(foldRefusal), dispatch,
            extra: { owedCiRerun: true },
          });
        }
        continue;
      }
      // we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — LIVE INCIDENT, PR #2783 (chalbert/
      // web-everything): three ci-heal sessions in one evening each ended "escalated (needs human — not a CI
      // break)" for the IDENTICAL reason on the IDENTICAL head, because the brief's escalation exit wrote
      // nothing durable (a bare one-line RETURN to the calling session) — every tick that followed re-read the
      // PR as plain `ci-red` with nothing live working it and dispatched ANOTHER heal to re-ask the same
      // already-answered question. `ci-heal-escalation-mark.mjs` closes it: an escalated heal now posts a
      // durable, HEAD-SCOPED comment, and this check refuses re-dispatch for as long as the escalation still
      // names the CURRENT head — a new push moves the head, the old comment stops matching, and the very next
      // tick plans a fresh heal with no human intervention required. Checked BEFORE the `ci-heal` cap below
      // (and skips it entirely) for the same reason `owed-ci-rerun` is: an escalation is a DIFFERENT, more
      // definitive stop than "one more round against the attempt cap".
      const escalation = latestCiHealEscalationForHead(pr?.comments, base.headRefOid);
      if (escalation) {
        const isSystemFix = escalation.outcome === 'waiting-on-system-fix';
        // we:backlog/fix-review-ciheal-deadlock (LIVE DEADLOCK 2026-09-28/29, PR #2878, web-everything/web-everything)
        // — the THIRD escalation outcome (`ci-heal-escalation-mark.mjs#CI_HEAL_ESCALATION_OUTCOMES`): ci-heal
        // examined the PR and confirmed the red is the review gate itself (held by the `review:pending`/
        // `review:human` label), not a CI break — a STRUCTURED verdict, never parsed from `reason` prose. Unlike
        // a genuine `needs-human` (a real judgment call on the diff) this is NOT a dead end an operator must be
        // pulled in for: the PR is owed its ordinary review, right now, exactly as `owed-ci-rerun` above already
        // dispatches review IN PARALLEL with its own ci-side refusal. Before this outcome existed, the ONLY
        // bucket available for "not a CI break" was `needs-human`, and the generic `needs-human`/`ci-heal-
        // escalated` refusal below unconditionally `continue`s past this PR — which is exactly how #2878
        // deadlocked: the review daemon's OWN dispatch reads this SAME plan, saw `ci-heal-escalated` and no
        // `review` row, and stood down every tick, while ci-heal (correctly) refused to re-heal a PR with
        // nothing left to heal. Two correct local refusals, no dispatcher ever asking the other question.
        const isNotCiBreak = escalation.outcome === 'not-a-ci-break';
        // #4263 — a `waiting-on-system-fix` escalation names a fix PR (`escalation.systemFixRef`) and refuses
        // ONLY until that fix lands; it must not suppress healing FOREVER once the fix PR is actually
        // merged/closed and CI reruns on this SAME head (no new push to move it). `pr.systemFixLanded` is
        // EVIDENCE injected by `reconcile-pass.mjs#enrichPrsWithSystemFixFacts` (this file stays IO-free): it
        // independently re-checks the referenced `systemFixRef` PR's own current state before this refusal is
        // ever honored. A plain `needs-human`/`not-a-ci-break` escalation names no PR to re-check and is
        // entirely unaffected — this only ever gates the `isSystemFix` branch.
        if (isSystemFix && base.systemFixLanded) {
          notes.push({
            kind: 'system-fix-landed', prNumber, headSha: escalation.headSha, systemFixRef: escalation.systemFixRef,
            text: `PR #${prNumber}: the system fix #${escalation.systemFixRef} this PR's ci-heal escalation was` +
              ` waiting on has since merged/closed — re-arming healing on head \`${escalation.headSha}\` with no` +
              ' new push required',
          });
          // Falls straight through to the ordinary ci-heal cap/dispatch path below, exactly as if this PR had
          // never been escalated at all — never a second, separate re-dispatch path to keep in sync with it.
        } else {
          const kind = isSystemFix ? 'waiting-on-system-fix' : 'ci-heal-escalated';
          refuse(kind, {
            ...withPhase, headSha: escalation.headSha,
            ...(escalation.reason ? { escalationReason: escalation.reason } : {}),
            ...(escalation.systemFixRef ? { systemFixRef: escalation.systemFixRef } : {}),
            why: isSystemFix
              ? `ci-heal already escalated this exact head (\`${escalation.headSha}\`) as waiting on system fix #${escalation.systemFixRef} — the red is the tooling/gate's own fault, not this PR's; nothing further is owed until that fix lands or a new push changes this head`
              : isNotCiBreak
                ? `ci-heal already confirmed this exact head (\`${escalation.headSha}\`) is NOT a CI break — the red is the review gate itself, held by the review label. No further heal is owed; review waits for complete successful required checks`
                : `ci-heal already escalated this exact head (\`${escalation.headSha}\`) to a human — re-dispatching would re-ask the identical already-answered question every tick until a new push changes this head`,
          });
          // A capped/exhausted ci-red PR is already promoted from a bare refusal to a surfaced `note`
          // (`ci-heal-exhausted`, above) precisely because it is the one dead end an operator must be pulled in
          // for — a genuine `needs-human`/`waiting-on-system-fix` escalation is the SAME shape of dead end
          // (nothing live, nothing auto-heal can do about it right now) and gets the identical treatment, once
          // per tick, until a new push or a person clears it. `not-a-ci-break` is deliberately NOT a dead end
          // (see above) — it still gets this same informational note (an operator reading the report should
          // see why no MORE ci-heal is coming), but cannot override the required-check prerequisite for review.
          notes.push({
            kind: 'ci-heal-escalated', prNumber, headSha: escalation.headSha, outcome: escalation.outcome,
            ...(escalation.systemFixRef ? { systemFixRef: escalation.systemFixRef } : {}),
            text: isSystemFix
              ? `PR #${prNumber}: ci-heal escalated on head \`${escalation.headSha}\` — waiting on system fix #${escalation.systemFixRef}; will not re-dispatch until it lands or a new push changes this head`
              : isNotCiBreak
                ? `PR #${prNumber}: ci-heal confirmed head \`${escalation.headSha}\` is not a CI break (review gate only) — no further heal owed; review waits for complete successful required checks`
                : `PR #${prNumber}: ci-heal escalated on head \`${escalation.headSha}\` — ${escalation.reason || 'needs a human judgment call'}; will not re-dispatch until a new push changes this head`,
          });
          // Retain the escalation and fold the review prerequisite into the same row.
          // A comment claiming CI is irrelevant cannot override a required check's actual result.
          if (isNotCiBreak && withPhase.labels.includes('review:pending')) {
            const foldRefusal = foldReviewRefusalInto(refusals[refusals.length - 1], withPhase, 'ciHealNotCiBreak');
            dispatchReviewRow({
              pr, requiredChecks, withPhase, base, attempts: roundAttempts(), roundCap: effectiveRoundCap, now,
              refuse: foldRefusal, refuseCapExhausted: capExhaustedVia(foldRefusal), dispatch,
              extra: { ciHealNotCiBreak: true },
            });
          }
          continue;
        }
      }
      const retryBudget = pr.timeoutRetryBudget;
      if (retryBudget?.pending) {
        const why = `PR #${prNumber}: timeout retry needs your decision — ${retryBudget.reason ?? 'request outcome remains unresolved'}; no further rerun or heal is safe`;
        refuse('ci-heal-escalated', { ...withPhase, why });
        notes.push({ kind: 'timeout-retry-needs-human', prNumber, text: why });
        continue;
      }
      // xng7q1p: same-head mechanical retries never consume or rewrite heal markers.
      // All main-red, escalation and live-owner guards above retain precedence.
      if (retryBudget?.confirmed < 2 && pr.timeoutRetry?.eligible && pr.timeoutRetry.head === pr.headRefOid && pr.timeoutRetry.pr === prNumber) {
        dispatch.push({ ...base, ...withPhase, kind: 'ci-timeout-rerun', timeoutRetry: pr.timeoutRetry,
          why: 'complete timeout inventory and unchanged dependency closure; independent retry budget' });
        continue;
      }
      if (pr.timeoutRetry && !pr.timeoutRetry.eligible) notes.push({ kind: 'timeout-retry-ineligible', prNumber,
        text: `PR #${prNumber}: ${pr.timeoutRetry.reason}` });
      const ciHealAttempts = countCiHealComments(pr?.comments);
      if (ciHealAttempts >= ciHealCap) {
        refuse('cap-exhausted', {
          ...withPhase, attempts: ciHealAttempts, cap: ciHealCap,
          why: `the PR's own durable CI-heal count is ${ciHealAttempts} against a cap of ${ciHealCap} — auto-heal is exhausted here and a person must take it`,
        });
        // #xznd5za (epic #3383/#4075) — a capped `ci-red` PR must never be MERELY refused. `cap-exhausted` was
        // already the one dead end this whole ci-red branch could reach — a red required check with nothing
        // live working it, past its own attempt cap — and, unlike `awaiting-permission` above (the ONE other
        // refusal this file already promotes to a surfaced `note`), it was landing in the `refusals` array only:
        // printed once per tick beside every other refusal (`reconcile-pass.mjs#formatReport`) and otherwise
        // indistinguishable from an ordinary, expected `nothing-owed`. A PR that has burned every auto-heal
        // attempt is exactly the case a person must be pulled in for, so it gets the SAME surfaced-note
        // treatment `awaiting-permission` already gets, with the literal phrase an operator (or an escalation
        // reader grepping for it) can search on.
        // #4191 (epic #4075/#3383) — the operator's own queue/comment surfacing (see this note's callers) reads
        // as "needs your decision: fix attempts exhausted", WITH the last failure reason — a bare attempt count
        // makes the operator re-open the PR just to find out what is actually still red. `failingCheckNames`
        // reads the SAME `pr.statusCheckRollup` `withPhase`/`check` above already derived `check.state` from;
        // never re-fetched, never re-derived beyond naming the rows a `red` state already counted.
        const lastFailureReason = failingCheckNames(pr?.statusCheckRollup).join(', ') || 'required check failing (no readable check name)';
        notes.push({
          kind: 'ci-heal-exhausted', prNumber, attempts: ciHealAttempts, cap: ciHealCap, lastFailureReason,
          text: `PR #${prNumber}: ci-heal attempts exhausted (${ciHealAttempts}/${ciHealCap}) — auto-heal cannot`
            + ` repair this required-check failure any further; a person must take it over. Last failure: ${lastFailureReason}`,
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
    // been fixed for the CURRENT (latest) advisory note owes a FIX here, never the `review` the generic table
    // would otherwise dispatch for this phase — a fresh review before the finding is even addressed would just
    // re-run `advise` against the same broken head and repost the identical finding. Once a fix round completes,
    // this branch falls through to the ordinary `needs-human` → `review` path below, which re-runs `advise` and
    // posts the next real verdict on the repaired head. Gated on `phase === 'needs-human'` specifically — a
    // `bounced` PR (real `review:changes` present, phase 'bounced' wins in `classifyPr`) is handled by the
    // conflict-fix carve-out inside the generic cap step below, never here; the two populations are mutually
    // exclusive by phase.
    //
    // xaer296 (epic #3383) — "has THIS been fixed" is now an ORDER question
    // ({@link isLatestAdvisoryFindingAddressed}: does a fix-mark appear AFTER the latest advisory note?), NOT the
    // COUNT comparison (`advisoryFixes < advisoryNotes`) this branch used before. The count comparison only holds
    // when both histories start at 0/0 and move one-for-one; it breaks the moment a `review:human` PR already has
    // advisory-note history predating this marker mechanism — CONFIRMED LIVE on `web-everything/web-everything#2549`
    // (5 pre-existing advisory notes, exactly 1 genuine fix, `1 < 5` staying true forever) — the reconcile pass
    // kept re-dispatching a fixer at an ALREADY-fixed PR, which is exactly how a second fixer that (correctly)
    // found nothing to reproduce ended up standing down (see `we:scripts/conveyor/advisory-fix-mark.mjs`'s own
    // header for the full incident, and `countUnresolvedStandDowns`/`isAdvisoryMechanismStandDownSuperseded`
    // for how a stand-down already caused by this exact bug is recognized as non-terminal).
    // `advisoryFixes` (the durable attempt COUNT) is still read below, but ONLY for the CAP — a genuinely
    // unfixable finding must still stop after `advisoryFixCap` real attempts.
    //
    // xconv1-evidence FOLLOW-UP (web-everything/web-everything#2766/#2767, 2026-09-27) — `advisoryFixes` MUST count
    // COMPLETED EPISODES, never raw fix-mark COMMENTS: CONFIRMED LIVE, once the #xconv1-evidence fix correctly
    // read a CONVERTED note as addressed, the cap-exempt fresh review it owed ran and posted a BRAND NEW,
    // unrelated advisory finding — but the PR's 3 historical fix-mark comments had ALL landed inside that ONE
    // (broken, never-advanced) converted-note episode, and the raw lifetime comment count still read 3,
    // refusing the brand-new finding `cap-exhausted` with ZERO attempts ever made against it.
    // `countCompletedAdvisoryEpisodes` counts one per note that a fix genuinely followed (however many fix
    // attempts piled up before that happened), so #2766/#2767 correctly read as ONE spent episode, not three —
    // see that function's own docblock for why the simpler "count fix-marks since the latest note" fix was
    // tried and REJECTED (it would make the cap unenforceable against a genuinely never-fixed finding).
    if (phase === 'needs-human' && withPhase.labels.includes(ADVISORY_LABELS.CHANGES)) {
      const advisoryFixes = countCompletedAdvisoryEpisodes(pr?.comments);
      const addressed = isLatestAdvisoryFindingAddressed(pr?.comments);
      if (!addressed) {
        // REFUSAL 2, narrowed to this population: `advisory:changes` implies a posted advisory note, which IS a
        // real finding — countFindings should never read 0 here, but this is named rather than silently
        // falling through to the generic `no-findings` branch below (which never dispatches a fix for a
        // zero-finding PR).
        const advisoryFindingsHere = countFindings(pr?.comments);
        if (advisoryFindingsHere === 0) {
          refuse('no-findings', {
            ...withPhase, findings: 0, comments: Array.isArray(pr?.comments) ? pr.comments.length : 0,
            why: 'labelled advisory:changes but no admitted finding is on the thread — refusing to invent one',
          });
          continue;
        }
        if (advisoryFixes >= advisoryFixCap) {
          // advisory-after-cap (web-everything/web-everything#2766, live-caught 2026-09-27): the cap above is right to
          // stop ANOTHER FIXER — but it must never ALSO block the one fresh review a head that moved AFTER the
          // last advisory note is still owed. Live shape: a fixer (a merge-conflict resolution, `main` merged in
          // to clear a stale `mergeStateStatus`) pushed a new head — posting its OWN, different marker
          // (`CONFLICT_FIX_COMMENT_MARKER`, never `ADVISORY_FIX_COMMENT_MARKER`) — AFTER the advisory-fix cap had
          // already tripped. `addressed` stays correctly `false` (no advisory-fix mark exists to postdate the
          // note), so this cap fired — but the operator's own rule (`we:lib/advisory-labels.mjs`'s file header)
          // is "no look until the PR carries an advisory for its CURRENT head", and every advisory note on this
          // thread was posted against an OLDER head. Refusing outright leaves a human staring at a `cap-exhausted`
          // PR with nothing current to read and no way for the mechanism to ever hand them one.
          //
          // THE FIX: reuse the SAME "does the newest advisory cover this head" test the stale-label sweep already
          // trusts (`advisory-label-sweep.mjs`) — `latestAdvisory`/`advisoryCoversHead`
          // (`we:scripts/lib/advisory-labels.mjs`) — rather than inventing a second one. When it says the newest
          // advisory does NOT name the PR's live `headRefOid` (a head the mechanism has literally never seen),
          // dispatch ONE `review`, never a `fix` — the cap still binds every further FIX attempt, permanently.
          // When it DOES cover the current head (nothing has moved since that verdict — the ordinary "genuinely
          // unfixable" case every pre-existing test in this file pins), this stays a plain `cap-exhausted` refusal,
          // byte-identical to before. `latestAdvisory` requires a REAL, parseable advisory comment (its own
          // `**Verdict:**` + `Net basis: <base>..<head>` lines) to return anything at all — a PR with no such
          // comment (every fixture predating this item; a real advisory note ALWAYS carries both lines, per
          // `we:scripts/operations/review-pr.mjs#renderAdvisoryNote`) yields `undefined` here, and `undefined`
          // is treated as "no evidence either way" (stays capped) rather than "obviously stale" (a blank read
          // must never manufacture a review dispatch it cannot justify).
          //
          // SELF-LIMITING, same shape as the `addressed` exemption a few lines below: the moment this review
          // actually runs, `review-pr.mjs`'s `advise` step posts a FRESH advisory note against the CURRENT head
          // unconditionally — which flips `advisoryCoversHead` back to `true` for the next tick, so this path
          // fires AT MOST ONCE per head movement. #2588's own one-review-per-head guard sits ahead of the
          // ordinary `OWED`-table review dispatch, never this one (this branch dispatches directly, exactly like
          // the `addressed` branch below it already does) — but it needs no restating here: the SAME evidence
          // that gates it (a reviewed-sha/advisory naming the current head) is exactly what `advisoryCoversHead`
          // just proved absent, so the two can never contradict each other on the same PR.
          const headSha = typeof pr?.headRefOid === 'string' ? pr.headRefOid.trim().toLowerCase() : '';
          // #3383 / PR #2806 review: only a TRUSTED author's advisory counts — `latestAdvisory` itself does no
          // author check, and WE's PRs are public, so an unfiltered read would let any commenter forge a
          // `Net basis:` line to suppress this review (naming the live head) or manufacture one (naming another).
          const trustedComments = Array.isArray(pr?.comments) ? pr.comments.filter(isTrustedMarkerAuthor) : [];
          const latest = headSha ? latestAdvisory(trustedComments) : undefined;
          const advisoryIsStale = Boolean(latest) && !advisoryCoversHead(latest, headSha);
          if (advisoryIsStale) {
            if (refuseReferralHold({ pr, refuse, withPhase })) continue;
            if (!reviewChecksAllow({ pr, requiredChecks, refuse, withPhase })) continue;
            dispatch.push({
              ...base, ...withPhase, kind: 'review', findings: advisoryFindingsHere,
              attempts: advisoryFixes, cap: advisoryFixCap,
              why: `the advisory-fix cap is exhausted (${advisoryFixes} of ${advisoryFixCap}) so no further fixer` +
                ` is dispatched, but the newest advisory (reviewed head \`${latest.head}\`) does not cover this` +
                ` PR's current head \`${headSha}\` — a fresh review is owed so the operator has a current` +
                ' advisory to act on, never another auto-repair attempt',
            });
            continue;
          }
          refuseCapExhausted({
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
      // `addressed` is true — a fix-mark already postdates the latest advisory note. A fresh review is owed AT
      // ONCE, dispatched HERE rather than falling through to the generic `OWED`-table path below, and — xaer296
      // FOLLOW-UP 2 (epic #3383) — deliberately EXEMPT from the generic shared `roundCap` that path would
      // otherwise apply.
      //
      // CONFIRMED LIVE, `web-everything/web-everything#2549`, 2026-09-24: once the count-vs-order bug and the
      // stand-down mechanism-failure gap above were both fixed, the real `runReconcilePass` correctly stopped
      // refusing `stood-down` — and immediately hit a THIRD gap instead: `cap-exhausted` at `5/5` against
      // `NEGOTIATION_ROUND_CAP`. That 5 is `countAdvisoryComments` — the very COUNT OF ADVISORY NOTES, i.e. the
      // number of times a review has ALREADY RUN against this PR — fed into a cap meant to bound REPEATED
      // FAILURE to converge (#2117/#2298's own motivating incident: a bounced PR that never completes a
      // rearm). Applying that same floor to "a review is owed right now, because the finding it will judge was
      // JUST mechanically proven fixed" cannot be right: it caps the discovery step by counting its own past
      // discoveries, and #2549 had genuinely spent that count on ORDINARY history predating the `#xkmu3gv`
      // marker regime entirely (5 rounds, 1 genuine advisory-fix) — capping it here would leave the PR
      // PERMANENTLY stuck at `cap-exhausted` even though the actual finding is provably addressed and nothing
      // further is owed except letting the review run.
      //
      // THE SMALLER OF TWO SAFE FIXES (a full dedicated `ADVISORY_REVIEW_ROUND_CAP` counter, counted only from
      // markers newer than `#xkmu3gv`, was the other option) — chosen because this exemption is SELF-LIMITING
      // by construction, with no new counter needed: the moment this review actually runs, `review-pr.mjs`'s
      // `advise` step posts its OWN fresh advisory note UNCONDITIONALLY on every `review:human` PR — which
      // immediately flips {@link isLatestAdvisoryFindingAddressed} back to `false` for the NEXT tick. So this
      // exemption can fire AT MOST ONCE per completed advisory-fix round, and advisory-fix rounds are already
      // bounded by {@link ADVISORY_FIX_ROUND_CAP} (checked above, on the `!addressed` branch) — a PR cannot
      // cycle through this exemption more than `advisoryFixCap` times before THAT cap (not this one) correctly
      // stops it and hands it to a person. A normal PR that has never addressed its advisory finding (the
      // ordinary `!addressed` branch above) is completely unaffected — it never reaches this line at all.
      const advisoryFindingsHere = countFindings(pr?.comments);
      if (refuseReferralHold({ pr, refuse, withPhase })) continue;
      if (!reviewChecksAllow({ pr, requiredChecks, refuse, withPhase })) continue;
      dispatch.push({
        ...base, ...withPhase, kind: 'review', findings: advisoryFindingsHere,
        why: 'the admitted advisory:changes finding was already addressed by a fix postdating it (order, not' +
          ' count) — a fresh review is owed at once to judge the repaired head, exempt from the shared' +
          ' negotiation-round cap (that cap\'s own count is fed by past advisory notes — this review\'s own' +
          ' future output — not by a failure to converge)',
      });
      continue;
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
    // CONFIRMED LIVE 2026-09-24: `web-everything/web-everything#2578` (`review:accepted`, base
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
        // #2787-live-incident — see {@link CONFLICT_FIX_ABSOLUTE_CEILING}'s own docblock: `currentRef` is this
        // PR's OWN stacked base (never `defaultBranch` here, by construction of `isStackedBase`); a round
        // resolved against an EARLIER tip of that same base (rebased since, or a wholly different base this PR
        // once stacked on) does not count against the smaller per-target cap, only the hard ceiling.
        //
        // #4265 — `currentSha` USED TO BE HARDCODED `null` here, in contrast to the main-base branch below it
        // (which threads a real, freshly-resolved `mainSha`). With no sha, `countStaleConflictFixRounds`'s
        // sha-vs-sha comparison never fires, so EVERY recorded round matching the ref alone counted as "the
        // same conflict" — even across repairs run against DIFFERENT, since-rebased tips of that same stacked
        // base. Three repairs against three different tips of a repeatedly-rebased stacked base exhausted the
        // smaller per-target cap even though each repair genuinely targeted a NEW tip. `base.baseRefSha` is
        // this PR's OWN base ref's current tip, resolved the SAME way (a plain local `git rev-parse`) as
        // `mainSha` is for the main-base branch — see `reconcile-pass.mjs#enrichPrsWithBaseRefFacts`.
        const { stale: conflictAttempts, total: conflictTotal } = countStaleConflictFixRounds(pr?.comments, {
          currentRef: baseRefName, currentSha: base.baseRefSha,
        });
        if (conflictAttempts >= conflictFixCap || conflictTotal >= CONFLICT_FIX_ABSOLUTE_CEILING) {
          refuseCapExhausted({
            ...withPhase, attempts: conflictAttempts, cap: conflictFixCap, capKind: 'stacked-rebase',
            why: conflictTotal >= CONFLICT_FIX_ABSOLUTE_CEILING
              ? `this PR's own durable conflict-fix count is ${conflictTotal} against the hard ceiling of ` +
                `${CONFLICT_FIX_ABSOLUTE_CEILING} (${conflictAttempts} against its current target, base ` +
                `\`${baseRefName}\`) — this PR keeps re-conflicting no matter how many rounds run; a person must take it over`
              : `this PR's own durable conflict-fix count is ${conflictAttempts} against a cap of ${conflictFixCap}` +
                ` — mechanical rebase against its base \`${baseRefName}\` is exhausted here and a person must take it`,
          });
        } else {
          dispatch.push({
            ...base, ...withPhase, kind: 'fix', isConflict: true, mode: 'stacked-rebase', baseRefName,
            attempts: conflictAttempts, cap: conflictFixCap,
            why: `conflicts with its own base \`${baseRefName}\` (not \`${defaultBranch}\`) — a stacked PR the ` +
              'drain will never land regardless of labels, so this is a mechanical rebase against its base, ' +
              `never a rebase owed to the drain; ${conflictAttempts} of ${conflictFixCap} conflict-fix attempts are spent` +
              (conflictTotal > conflictAttempts ? ` (${conflictTotal} total rounds ever run, against earlier targets)` : ''),
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

    // ── ONE REVIEW PER HEAD COMMIT (#2588/review-loops, epic #3383/#4075). Live-caught 2026-09-24: PR #2588 got
    // a `review:changes` verdict at 23:55Z and a `review:accepted` verdict at 00:00Z, five minutes apart, from
    // THREE separate review sessions dispatched within one 16-minute window — all reviewing the SAME head,
    // because the liveness read this pass relies on (REFUSAL 4, see this file's own header) had a gap a session
    // could fall through: a review session can finish and post its verdict to GitHub before `claude agents
    // --json` and this pass's next tick agree it is gone, so a fresh review got dispatched for a commit that
    // had, in fact, already been reviewed. This refusal is a SECOND, INDEPENDENT gate — it does not trust
    // liveness at all, only the PR's own durable record of what has already happened to its CURRENT head.
    //
    // `parseReviewedSha` recovers the head sha the LATEST accept-shaped verdict (`accepted`/`clear-human`/
    // `restamp` — never a bounce) covered, stamped by `we:scripts/review-set-label.mjs#buildVerdictComment`
    // (`stampsAcceptance`). When it equals this PR's CURRENT `headRefOid`, this exact commit has already been
    // reviewed and accepted — dispatching another review for it risks exactly the #2588 shape, a second verdict
    // landing on a commit nobody has touched since the first one. This is silent (never refuses) for a PR that
    // has only ever been BOUNCED, on purpose: a `review:changes` verdict stamps no `reviewed-sha` marker (it is
    // not an acceptance), so a real, unaddressed finding still gets its round through the ordinary paths below,
    // completely unaffected by this guard.
    //
    // ── REFUSAL 2 (review half) — no findings still owes a REVIEW: "nothing to FIX" is not "nothing to do" —
    // UNLESS that review population has itself exhausted the round cap. #2588/review-loops (epic #3383/#4075):
    // this branch used to dispatch with `attempts: 0` HARDCODED, so a PR stuck re-reading `needs-review`/
    // `needs-human` with zero findings every tick (a review session that crashes or never posts a verdict is
    // exactly this shape) re-dispatched a fresh review agent FOREVER. It reads the SAME durable count REFUSAL 3
    // binds on below.
    //
    // All three checks (the head guard, no-findings, the cap) live in {@link dispatchReviewRow} — the ONE copy,
    // shared with the ci-red-parallel review above (PR #2783 review: the review decision was duplicated here).
    if (OWED[phase] === 'review') {
      dispatchReviewRow({ pr, requiredChecks, withPhase, base, attempts: roundAttempts(), roundCap: effectiveRoundCap, refuse, refuseCapExhausted, dispatch, now });
      continue;
    }

    // ── THE CAP, from the PR and ONLY from the PR. See the fuller note at REFUSAL 3 below.
    const attempts = roundAttempts();

    // ── REFUSAL 2 — no findings, no fixer. A fix agent handed a PR with nothing to fix invents work.
    const findings = countFindings(pr?.comments);
    if (findings === 0) {
      refuse('no-findings', {
        ...withPhase, findings: 0, comments: Array.isArray(pr?.comments) ? pr.comments.length : 0,
        why: 'no reviewer finding on this PR — a fix agent would invent work. A review, not a fix, is what an unreviewed PR is owed.',
      });
      continue;
    }

    // ── CONFLICT-FIX (#xkmu3gv) — a `bounced` PR that ALSO carries `merge-status:conflicting` is the mechanical
    // conflict-resolution population `we:scripts/conveyor/reconcile-fix-dispatch.mjs`'s own `isConflict` flag
    // already identifies (`origin/lane/xdhidso-review-human-statute-fixer`, PR #2577's routing rule). It binds
    // on its OWN, smaller cap ({@link CONFLICT_FIX_ROUND_CAP}), counted from its OWN marker
    // (`countConflictFixComments`) — NEVER the shared `roundCap`/`countRearmComments`/`countAdvisoryComments`
    // floor below, which a PR can independently have already exhausted on real review negotiation (CONFIRMED
    // LIVE: `web-everything/web-everything#2549`, `review-round:5` against the shared cap of 5, zero conflict-fix
    // rounds ever run). See that constant's own docblock for the full incident.
    const isConflictBounce = phase === 'bounced' && withPhase.labels.includes(CONFLICT_LABEL);
    if (isConflictBounce) {
      // #2787-live-incident — `currentRef` is `defaultBranch` (this population is, by definition, a main-base
      // conflict); `mainSha` is `origin/<defaultBranch>`'s own current tip, when the IO shell supplied one (see
      // {@link CONFLICT_FIX_ABSOLUTE_CEILING}'s own docblock). A round that resolved against an EARLIER main —
      // main moved and created a genuinely NEW conflict since — does not count against the smaller per-target
      // cap below, only the hard ceiling.
      const { stale: conflictAttempts, total: conflictTotal } = countStaleConflictFixRounds(pr?.comments, {
        currentRef: defaultBranch, currentSha: mainSha,
      });
      if (conflictAttempts >= conflictFixCap || conflictTotal >= CONFLICT_FIX_ABSOLUTE_CEILING) {
        refuseCapExhausted({
          ...withPhase, attempts: conflictAttempts, cap: conflictFixCap, capKind: 'conflict-fix',
          why: conflictTotal >= CONFLICT_FIX_ABSOLUTE_CEILING
            ? `this PR's own durable conflict-fix count is ${conflictTotal} against the hard ceiling of ` +
              `${CONFLICT_FIX_ABSOLUTE_CEILING} (${conflictAttempts} against its current target, \`${defaultBranch}\`)` +
              ' — this PR keeps re-conflicting no matter how many rounds run; a person must take it over'
            : `this PR's own durable conflict-fix count is ${conflictAttempts} against a cap of ${conflictFixCap}` +
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
          + (conflictTotal > conflictAttempts ? ` (${conflictTotal} total rounds ever run, against earlier targets)` : '')
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
    // `attempts` itself is `roundAttempts()` — the SAME derivation the review population's cap reads (via
    // {@link dispatchReviewRow}), so the two can never disagree about how many attempts a PR has spent. Only the
    // `fix` population reaches this point: every `review`-owed phase returned through that helper above.
    if (attempts >= effectiveRoundCap) {
      refuseCapExhausted({
        ...withPhase, attempts, cap: effectiveRoundCap, capKind: 'fix',
        why: `the PR's own durable attempt count is ${attempts} against a cap of ${effectiveRoundCap} — auto-repair is exhausted here and a person must take it`,
      });
      continue;
    }

    dispatch.push({
      ...base, ...withPhase, kind: 'fix', findings, attempts,
      why: `bounced with ${findings} finding(s), nothing live is working it, and ${attempts} of ${effectiveRoundCap} attempts are spent`,
    });
  }

  for (const entry of dispatch) {
    if (entry.kind !== 'fix') continue;
    const sourcePr = prs.find((pr) => Number(pr?.number) === entry.prNumber);
    // Older/hand-opened PRs may lack an episode marker; creation still bounds starvation.
    const since = fixWaitingSince(sourcePr?.comments) || sourcePr?.createdAt;
    if (since) entry.waitingSince = since;
  }
  return { dispatch, refusals, notes };
}

/**
 * we:scripts/conveyor/reconcile-core.mjs#selectStatusCandidates — PURE: which PRs deserve an informative
 * `review-status:*` refresh (`we:scripts/conveyor/review-status-tag.mjs`) this tick, given this pass's own
 * `dispatch`/`refusals` output.
 *
 * EVERY PR THIS PASS HAS AN OPINION ABOUT — including `nothing-owed`. `owed-elsewhere` never meant "unrelated
 * PR": it fires for a `needs-human`/`conflicted` phase alike (`ci-red` moved OFF this table at multi-repo
 * slice 7 — it is a real `dispatch` entry, `kind:'ci-heal'`, now, not a refusal), which are real
 * conveyor-dispatched PRs stuck on something this pass does not run (a human clear, a rebase) — NOT unrelated
 * PRs. Before this function existed, `we:skills-src/conveyor/runner.mjs`'s own inline filter excluded
 * `owed-elsewhere` wholesale on the mistaken premise that it "covers every unrelated human PR" — confirmed
 * live 2026-09-05 on PR #1920: its `needs-human` refusal (kind `owed-elsewhere`) was excluded from every
 * tick's refresh sweep, so its stale `review-status:reviewing` label — left over from a session that no
 * longer exists in `claude agents --json` at all — was NEVER re-derived and cleared. `review-status-tag.mjs`
 * is idempotent and name-keyed (matches `review-<pr>`/`fix-<pr>` sessions fresh each call), so calling it on a
 * PR with nothing live simply clears any stale label — safe to call on every candidate this returns, including
 * a genuinely-foreign PR that happens to reach `owed-elsewhere` (a wasted `gh`/`claude agents` read at worst,
 * never a wrong label).
 * SAME BUG CLASS, SECOND TIME (live-caught 2026-09-22, PR #2472): a PR that moves to being owed a FIX
 * (`plan.dispatch`'s `kind:'fix'` entries — e.g. a `review:changes` bounce) used to be in NEITHER
 * `reviewsOwed` NOR `refusals`, so its status label never got re-derived once it left the review-owed
 * state. PR #2472's own `review-2472` session finished and posted its real `review:changes` verdict, but
 * `review-status:reviewing` sat stale on the PR for ~2 hours — nothing ever called `review-status-tag.mjs`
 * for it again to notice the session was `done` and clear the label. Exactly the same root shape as the
 * `owed-elsewhere` miss documented above (a real, currently-relevant PR silently excluded from the refresh
 * sweep), just a different exclusion. Fixed by adding `fixesOwed` as a THIRD candidate source, included the
 * same unconditional way `reviewsOwed` already is.
 * SAME BUG CLASS, THIRD TIME (live-caught 2026-09-26, PR #2711, card x8who76): `nothing-owed` used to be
 * excluded outright on the premise that it "genuinely means reviewed and queued, already landed, or a
 * signal-free PR unrelated to this loop" — true of its STEADY STATE, but false at the exact instant a PR
 * TRANSITIONS into it. `classifyPr` resolves `review:accepted`/`ready-to-merge` to phase `queued`, which is
 * neither in `OWED` nor `OWED_ELSEWHERE`, so it refuses as `nothing-owed` — and that exclusion meant a PR
 * whose review had JUST been accepted (carrying a `review-status:reviewing` label from the round that just
 * finished) never got `review-status-tag.mjs` called again to notice the review session/job was gone and
 * clear it. Confirmed live: PR #2711 got `review:accepted` at 13:07Z and `ready-to-merge` at 13:08Z but still
 * carried `review-status:reviewing` (added 12:59Z) at 13:12Z — the operator read "accepted AND reviewing",
 * a live contradiction. Fixed the same way as the other two: stop excluding it. `review-status-tag.mjs`'s own
 * idempotency argument above applies identically to `nothing-owed` — a PR that was NEVER live costs one
 * wasted read (or nothing at all when reads are shared, #4133) and no label ever gets written; a PR that just
 * WENT quiet finally gets its stale label cleared within one tick instead of never.
 * SAME BUG CLASS, FOURTH TIME (live-caught 2026-09-26, PR #2742, card xg790dh): the docblock above already
 * NAMED the shape ("`ci-red` moved OFF this table at multi-repo slice 7 — it is a real `dispatch` entry,
 * `kind:'ci-heal'`, now, not a refusal") but never actually closed it — a `kind:'ci-heal'` dispatch entry was
 * in NEITHER `reviewsOwed` NOR `fixesOwed` (both filter on a DIFFERENT literal `kind`) NOR `refusals` (it is a
 * `dispatch`, never refused, whenever the ci-heal cap is unspent), so a PR that moves from being owed a FIX to
 * being owed a CI-HEAL fell out of the sweep entirely, the exact same shape #2472/x8who76 already fixed for the
 * review→fix and accept→queued transitions. Confirmed live: PR #2742's `fix-2742` session finished (`state:
 * 'done'`, idle 11+ min) and CI went red on its re-push (`ci:failed`), so the very next tick's plan carries a
 * `kind:'ci-heal'` dispatch for #2742 — but `review-status:fixing` (added while the fix was genuinely live)
 * sat stale on the PR indefinitely, because nothing ever called `review-status-tag.mjs` again to notice the
 * fix session was `done` and either clear it or replace it with `healing-ci` once a ci-heal session picks it
 * up. Fixed by adding `ciHealsOwed` as a FOURTH candidate source, included the same unconditional way the other
 * three already are — `review-status-tag.mjs`'s own idempotency argument applies identically here.
 * @param {Array<{prNumber:number}>} reviewsOwed - the `kind:'review'` subset of this pass's own `dispatch`
 * @param {Array<{kind:string, prNumber:number}>} refusals - this pass's own `refusals`
 * @param {Array<{prNumber:number}>} [fixesOwed] - the `kind:'fix'` subset of this pass's own `dispatch`
 * @param {Array<{prNumber:number}>} [ciHealsOwed] - the `kind:'ci-heal'` subset of this pass's own `dispatch`
 * @returns {Array<{prNumber:number}>} reviewsOwed + fixesOwed + ciHealsOwed + every refusal, `nothing-owed` included
 */
export function selectStatusCandidates(reviewsOwed, refusals, fixesOwed, ciHealsOwed) {
  return [
    ...(Array.isArray(reviewsOwed) ? reviewsOwed : []),
    ...(Array.isArray(fixesOwed) ? fixesOwed : []),
    ...(Array.isArray(ciHealsOwed) ? ciHealsOwed : []),
    ...(Array.isArray(refusals) ? refusals : []),
  ];
}
