/**
 * review-set-label.mjs — swap a PR's review label, INVARIANT-2 guarded (#2470, increment 2 of 2). Also the
 * SINGLE HOME of the shared review-label CLI harness (#2644): a PURE `decideSetLabel` decides the swap for a
 * reviewer verdict (`accepted` / `changes`) OR the fix-agent re-arm (`rearm`), and a thin `runReviewLabelCli`
 * does the `gh` observe→write→re-read arc (the two writes are the comment and the label swap; which one goes
 * first is decided per-PR by the #2964 ordering rule — see `runReviewLabelCli`). The conveyor's
 * `rearm-review.mjs` is now a THIN shim over
 * both (it used to clone this file byte-for-byte). Single-sourced in WE (Native-First / zero standard-impl here
 * — this is a definition + write tool, not product code) so the plateau console and the conveyor fix agent both
 * shell/import it rather than re-implementing how a label swap lands.
 *
 * #2844 — INVARIANT 2 says a `review:human` PR may not be machine-cleared; it says NOTHING about who clears a
 * `review:pending` one, and before #2844 nothing else did either. This CLI now REFUSES an `--to=accepted` verdict
 * whose clearing actor is provably the PR's own author (`we:scripts/lib/review-independence.mjs`), stamps the
 * clearing actor's id into the durable comment, and — when independence could not be established — says so in that
 * comment rather than leaving a silence a reader would misread as independence.
 *
 * `--to=clear-human` IS EXEMPT FROM THAT REFUSAL (PR #1100 review). The actor id is `CLAUDE_CODE_SESSION_ID` and a
 * SUBAGENT INHERITS ITS PARENT'S, so the comparison is SESSION-level and the operator's own `/review` ceremony —
 * which shells this CLI from inside the session that opened the PR — is a self-clear by that measure. Refusing the
 * human ceremony too made NOTHING clearable through the sanctioned path. The exemption is not a weakening: the
 * ceremony is refused unless the PR carries `review:human` and requires an explicit `--actor` plus a quoted
 * `--reason`, and the durable comment records that a HUMAN CEREMONY cleared it, never that an
 * established-independent agent did. THERE IS NO `--force` AND NO FLAG that lifts the `--to=accepted` refusal:
 * the two routes that clear a self-authored PR are the `clear-human` ceremony (on a `review:human` PR) and running
 * the review from a session that did not open the PR. The refusal message names exactly those two.
 *
 * INVARIANT 2 (the whole point): a `review:human` PR is NEVER cleared to `review:accepted` by anything but a
 * human's /review ceremony. `decideSetLabel` REFUSES `to==='accepted'` when the PR carries `review:human`
 * (`gate-self` is human-ceremony-only). The refusal lives in the PURE core so it is unbypassable — the CLI
 * cannot route around it. Do NOT weaken it. The `rearm` target carries the sibling #2630 invariant: an auto-fix
 * re-arms `review:changes → review:pending` but NEVER emits `review:accepted` and NEVER removes `review:human`.
 *
 * #2895 — INVARIANT 2 says who may NOT clear a gate-self PR; the `clear-human` target says how the one who MAY
 * actually does it. Before this, #2882 closed the raw label edit without opening a replacement, so the single
 * act the `review:human` tier exists to enable had no sanctioned way to perform it and the operator was pushed
 * to an unrecorded `gh` call — losing the `reviewed-sha` stamp and the attributed comment. `clear-human` is the
 * ONLY target that removes `review:human`, and `accepted` stays unconditionally refused on a `review:human` PR
 * — see `decideSetLabel` for why this is a target rather than a flag.
 *
 * WHAT THIS TARGET DOES NOT DO, stated up front so nobody re-derives it: it does NOT verify that a human ran
 * it. #2895 RULED that the unforgeable actor signal is DEFERRED — no local construct survives an agent with
 * shell access on the same machine (a flag is trivially passed; a local console's token is scrapeable; a tty
 * check is satisfied by `script`/`expect`). So this ships as the raw command with better manners, and the
 * manners are the point: the `reviewed-sha` stamp, an attributed comment, a stated reason, one documented path
 * instead of an ad-hoc paste. The mitigation that replaces the missing signal is the HONESTY TAX — `--actor`
 * and `--reason` are both REQUIRED, so misuse takes a lie rather than a silence, and every surface that reports
 * a clearance says what the record proves (the sanctioned path was followed) and not what it does not (that a
 * human followed it). The durable fix is #2946 (a hardware human-presence gesture), filed `someday`.
 *
 * Split mirrors `we:scripts/review-detail.mjs`: a PURE decider that takes the already-observed labels and
 * returns the swap, plus a thin impure CLI that does the `gh` calls and prints. REUSES
 * `we:scripts/lib/review-escalation.mjs` (`REVIEW_LABELS`, `hasReviewLabel`) — it never re-hardcodes the
 * label strings.
 */
import { basename, dirname, join, resolve, sep } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Rebase resolution (2026-08-08): the UNION of both sides. `buildReviewedDiffMarker` is #2979's accept
// fingerprint, `READY_TO_MERGE_LABEL` is #2832's hold invariant, `buildReviewedContributionMarker` is
// #x9xqexm's base-independent third marker. Independent concerns.
import {
  REVIEW_PR_CHANNEL, REVIEW_LABELS, hasReviewLabel, buildReviewedShaMarker, buildReviewedDiffMarker,
  buildReviewedContributionMarker, buildClearedHumanMarker, READY_TO_MERGE_LABEL,
  // #3007 — the SAME two digests the markers carry, taken raw so the ledger row records the witnesses
  // themselves rather than re-deriving them from the rendered comment. One computation, two consumers.
  normalizeDiffFingerprint, normalizeContributionFingerprint,
  // #x9krtkb — the `restamp` path's OWN read-back of the PR's comments: which acceptance is it carrying, was
  // that acceptance a HUMAN clearance, and does the fresh diff/contribution still cover it. `parseReviewedDiff`/
  // `parseReviewedContribution`/`parseOperatorClearance` already exist for the accept path's OWN staleness gate
  // (`acceptanceCoversHead`, `we:scripts/merge-ai-prs.mjs`); reused here rather than re-derived so the two
  // readers can never disagree about what a comment carries. `parseLatestHumanClearedSha` doubles as BOTH the
  // human-clearance detector and the accepted SHA to compare against — it already binds the `reviewed-sha` and
  // `cleared-human` markers to the SAME comment (see its own docstring), so the SHA it returns IS
  // `parseReviewedSha`'s answer whenever it is non-null; a second independent parse would only ever agree.
  parseReviewedDiff, parseReviewedContribution, parseOperatorClearance,
  parseLatestHumanClearedSha, acceptanceCoversHead,
} from './lib/review-escalation.mjs';
// #2844 — WHO cleared this verdict, and the refusal when that is the PR's own author. See that module's header
// for what the id rests on (the harness session identity, NOT the free-text `--actor`) and for the residual.
import {
  currentActorId, parseAuthorActorId, buildClearerActorMarker, decideClearerIndependence, INDEPENDENCE,
  hasStampLostMarker,
} from './lib/review-independence.mjs';
// #3007 PHASE 1 (SHADOW) — the append-only verdict ledger. This CLI is the SINGLE HOME of a label swap, so it
// is also the single home of a ledger row: every caller (the `/review` ceremony, the #3035 operation's label
// sink, the loop console, the conveyor's rearm) reaches the ledger by reaching THIS, and none of them needs
// its own writer. NOTHING MERGES ON IT YET — the drain still reads labels; `we:scripts/review-ledger-check.mjs`
// reports any ledger/label disagreement, and that evidence is what decides whether Phase 2 is safe.
import { buildVerdictRecord, appendVerdict, verdictForLabelTarget } from './lib/verdict-ledger.mjs';
// #2979 — the NET diff vs current main, NOT `gh pr diff`'s three-dot output (see the fingerprint block in
// `runReviewLabelCli` for why that distinction is the whole point). Imported from the CLI that owns it, the same
// way `we:scripts/fetch-parked.mjs` already does — it is the single home of the #2450 net-diff basis.
import { computeNetDiffText } from './merge-ai-prs.mjs';
import { parseDelegationMarker } from './lib/delegation-marker.mjs';
import { isDelegationTripleGraduated } from './conveyor/delegation-trial-gate.mjs';
import { readStore } from './conveyor/run-scorecard-store.mjs';
import { logDelegationTrial } from './conveyor/log-delegation-trial.mjs';
import { createGhProvider, writeOrder } from './lib/review-label-provider.mjs';
// #x01u7az — the advisory:* label pair `clear-human` must strip: an advisory only means something on a
// `review:human` PR (its own header), so a gate-self clearance that drops `review:human` must drop whichever
// advisory label is still riding along, or the label reads as if an independent advisory endorsed a head
// nobody re-ran it against. Also read by `decideSetLabel`'s `rearm` branch to keep the "at most one review:*
// hold" invariant enforceable from ONE imported constant rather than a re-typed literal.
import { ADVISORY_LABELS } from './lib/advisory-labels.mjs';
import { writeAllSync } from './lib/write-all-sync.mjs';
// #3631 slice — the LAST bare `execFileSync` in this file's own gh-adjacent write path. This exec closure is
// `computeNetDiffText`'s injected exec, and today it is only ever invoked with `cmd==='git'` (a fetch/diff/
// merge-base against `origin`, never a `gh` call — the label reads/writes above already route through
// `createGhProvider()`'s own throttled default, wired earlier under #3621). It was still a hand-rolled, fully
// generic `(cmd, args, opts) => execFileSync(cmd, args, opts)` passthrough with NO throttle/backoff awareness at
// all, unlike every other subprocess seam in this file. `execFileSyncThrottled` is the EXACT byte-for-byte
// transparent drop-in for that shape (`we:scripts/lib/gh-throttle.mjs` — the same function
// `we:scripts/conveyor/ci-queue-watch.mjs#defaultListRuns` already defaults to): it special-cases `file==='gh'`
// through the semaphore+backoff wrapper and falls straight through to a real `execFileSync(file, args, opts)`
// for anything else, so swapping it in here changes NOTHING about today's git-only behaviour while closing the
// gap for good — a future caller of `computeNetDiffText` that ever threads a `gh` call through this same
// closure (or a copy-paste of it elsewhere) inherits the throttle for free instead of re-introducing the bare
// call. See `we:backlog/3631-migrate-remaining-gh-cli-call-sites-to-the-gh-throttle-wrapp.md` for the tracked
// item this is one slice of.
import { execFileSyncThrottled } from './lib/gh-throttle.mjs';
// #xwp8ioh — the #2953 inert-PR predicate, extracted so `review-pr`'s `read` step enforces the same rule
// before a juror is paid instead of this site being the only place it is checked.
import { classifyPrLiveness, inertPrMessage } from './lib/pr-liveness.mjs';
// #3334 — the reasonless-bounce rule. A LEAF module with no imports, so the other route that must hold it
// (`we:scripts/operations/record-verdict.mjs`, which asserts an EMPTY external import graph) can too; see that
// file's header for why the split exists. Re-exported below so this file stays the single place to look.
import {
  REASONLESS_BOUNCE_REFUSAL, isReasonlessBounce, RENDERED_FINDINGS_HEADING, bounceEvidenceFromWriteUp,
} from './lib/reasonless-bounce.mjs';

/**
 * we:scripts/review-set-label.mjs#REVIEW_LABEL_TARGETS — the CLOSED set of label-swap targets `decideSetLabel`
 * understands. Exported so anything that must be TOTAL over the targets (the comment-size projection below, and
 * its enum-totality test) enumerates this one list instead of hardcoding a member — PR #1056 review, M2: the
 * `GH_COMMENT_MAX` pre-flight hardcoded `to: 'accepted'` and therefore under-counted a `clear-human` comment by
 * the 132 chars of extra chrome, so a body in the 65,405–65,536 band passed the check and `gh pr comment` then
 * failed on GitHub's cap. Under the then-current swap-first order that left an ACCEPTED PR with no `reviewed-sha`
 * marker, which `acceptanceCoversHead` fails OPEN on. #2964 reordered the writes so a first accept can no longer
 * reach that state (see `runReviewLabelCli`), but the projection still has to be total: an under-counted body now
 * costs a failed run and a lost record, and on an ALREADY-accepted PR — the one case that still swaps first — it
 * costs exactly the old partial state. Add a member here and the projection covers it automatically.
 */
export const REVIEW_LABEL_TARGETS = Object.freeze(['accepted', 'changes', 'rearm', 'clear-human', 'restamp']);

/**
 * we:scripts/review-set-label.mjs — THE #3334 REASONLESS-BOUNCE RULE, re-exported from its leaf module so this
 * file stays the one place a reader looks for what governs a label swap. The rule itself lives in
 * `we:scripts/lib/reasonless-bounce.mjs` for ONE reason, stated there in full: the other route that must hold
 * it (`we:scripts/operations/record-verdict.mjs`) asserts an EMPTY external import graph, and this file reaches
 * `node:child_process` through `computeNetDiffText`. `decideSetLabel` below is still where the refusal is
 * DECIDED; the leaf only holds the predicate that decision asks.
 */
export { REASONLESS_BOUNCE_REFUSAL, isReasonlessBounce, RENDERED_FINDINGS_HEADING, bounceEvidenceFromWriteUp };

/**
 * we:scripts/review-set-label.mjs#decideSetLabel — the PURE verdict-label decision. Given the target `to` and
 * the PR's OBSERVED labels, return the label swap. FOUR targets (the closed set is `REVIEW_LABEL_TARGETS`), each
 * with its invariant enforced HERE (unbypassable): the reviewer verdicts `accepted` / `changes`, the conveyor
 * fix-agent `rearm` (#2644, was `decideRearm`), and the #2895 gate-self `clear-human`. Every return carries
 * `keepsHuman` — whether the swap leaves `review:human` in place.
 *   • `accepted` — INVARIANT 2: REFUSED on a `review:human` PR (only a human's /review may clear the gate);
 *     otherwise adds `review:accepted`, drops the parked `review:pending` AND a stale `review:changes` (#2974 —
 *     a bounce that was fixed and re-verdicted straight to `accepted` must not still read as awaiting changes).
 *   • `changes` — a bounce lands nothing, so it is allowed regardless of the PR's state, with ONE refusal:
 *     #3334's reasonless bounce (a KNOWN zero finding count and no stated reason — see `isReasonlessBounce`).
 *     Otherwise adds `review:changes`, drops `review:pending` AND a stale `review:accepted`, but NEVER
 *     `review:human`.
 *   • `rearm` — the #2630 invariant: ONLY a live `review:changes` is re-armable (idempotent — a second call
 *     refuses cleanly); the swap is ALWAYS `review:changes → review:pending`, NEVER `review:accepted`, and
 *     NEVER removes `review:human`. The strongest thing an auto-fix can do is re-arm the review, never clear it.
 *   • `clear-human` — the #2895 gate-self clearance: the ONLY target that removes `review:human` (and the only
 *     one refused when the PR does NOT carry it). Nothing here checks WHO is asking — see below.
 *   • `restamp` — the #x5e2ldj re-stamp: moves NO label at all. It exists because the drain's own
 *     content-preserving rebase moves the head, which makes the acceptance markers stale, which re-parks the
 *     very PR the drain was about to land — clear, rebase, re-park, forever. `review-escalation.mjs` names this
 *     fix in its POSITION section: the drain KNOWS it produced the rebase, so it can re-stamp rather than have
 *     a gate re-derive. REFUSED unless a live `review:accepted` is already on the PR: a re-stamp may only carry
 *     an acceptance ACROSS a head move, never manufacture one.
 * @param {{to:('accepted'|'changes'|'rearm'|'clear-human'), currentLabels?:Array, findingCount?:number|null,
 *   reason?:string}} o - `currentLabels` is the observed label array (string or `{name}` shape, per
 *   `hasReviewLabel`). `findingCount` and `reason` are the #3334 decision inputs: how many findings the juror
 *   raised (tri-state — `null` is UNKNOWN and never refuses) and the reason the caller stated, if any. They are
 *   ARGUMENTS, never fetched: this function is pure and stays pure.
 * @returns {{allowed:boolean, addLabel:string, removeLabels:string[], keepsHuman:boolean, reason:string}}
 */
export function decideSetLabel({ to, currentLabels = [], findingCount = null, reason = '' } = {}) {
  // we:scripts/review-set-label.mjs#decideSetLabel — only the targets in the closed set are valid.
  if (!REVIEW_LABEL_TARGETS.includes(to)) {
    throw new Error(
      `decideSetLabel: unknown verdict '${to}' — expected ${REVIEW_LABEL_TARGETS.map((t) => `'${t}'`).join(', ')}`,
    );
  }

  const isHuman = hasReviewLabel(currentLabels, REVIEW_LABELS.human);

  // we:scripts/review-set-label.mjs#decideSetLabel — clear-human (#2895): the ONE target that removes
  // `review:human`, and the only sanctioned way to clear a gate-self PR. It exists because #2882 closed the raw
  // label edit (rightly) without opening a replacement, leaving the single act the `review:human` tier exists to
  // enable with no way to perform it — the operator was pushed to an unrecorded `gh` call outside the flow,
  // which is exactly the attribution loss the single home was built to prevent.
  //
  // WHY A TARGET, NOT A FLAG ON `accepted` (#2895 asked for this to be decided, not defaulted): a
  // `--clear-human` flag would make INVARIANT 2 conditional — `accepted` would sometimes clear a gate-self PR —
  // so every future reader of the `accepted` branch would have to check whether the lift was passed. As its own
  // target, `accepted` stays UNCONDITIONALLY refused on a `review:human` PR (the branch below is unchanged), and
  // the clearance is impossible to reach by fumbling a flag on the ordinary accept path. A member added to a
  // single-sourced decider is hard to remove later, so the narrower shape wins.
  //
  // Nothing here checks WHO is asking, and nothing anywhere else does either — #2895 ruled the unforgeable
  // actor signal deferred (see the file header). What stands in the way of a clearance nobody asked for is the
  // honesty tax in `runReviewLabelCli` (`--actor` + `--reason` are required and are quoted verbatim into the
  // durable comment, so misuse takes a written lie rather than a silent label add) and the explicit-instruction
  // rule in `we:skills-src/review/SKILL.md`. The `allowClearHuman` opt-in is a much smaller thing than either —
  // it binds importers only, and today it binds none (see its doc on `runReviewLabelCli`). None of the three is
  // a barrier.
  if (to === 'clear-human') {
    if (!isHuman) {
      return {
        allowed: false,
        addLabel: '',
        removeLabels: [],
        keepsHuman: false,
        reason: 'no review:human label — nothing to clear (use --to=accepted for an ordinary parked PR)',
      };
    }
    return {
      allowed: true,
      addLabel: REVIEW_LABELS.accepted,
      // Drops the human gate AND any parked/bounced state: a cleared gate-self PR must not still read as
      // awaiting review or as a live bounce. `presentRemoveLabels` narrows this superset to what the PR carries.
      // #1920 round-2 review — ALSO strips a stale `redteam:accepted`, same reasoning as `changes`/`rearm` below:
      // that label carries no SHA marker of its own, and `clear-human` is a ROUTINE recovery ceremony that fires
      // on a RE-PARK to `review:human` — a PR touching both an engine-tier file (earning `redteam:accepted` at
      // some earlier head) and a declarative-leash/gate-self file (forcing the human hold) could otherwise carry
      // that earlier sign-off straight through a later `clear-human` clearance without the independent validator
      // ever having seen the head it is now being applied to (this is NOT the plain `accepted` target's happy
      // path, where a fresh `redteam:accepted` and a fresh `review:accepted` are meant to be stacked together for
      // the SAME head — `accepted` deliberately does NOT strip it, or the two verdicts could never coexist; see
      // gate-invariants.test.mjs INVARIANT 14/15). `clear-human` instead clears an EXPLICIT hold, like a bounce,
      // so the same "needs fresh eyes" posture applies.
      // #x01u7az — an `advisory:*` label only ever means "the independent advisory ran on a review:human PR"
      // (`we:scripts/lib/advisory-labels.mjs`'s own header). The moment `review:human` comes off, that context is
      // gone, so any advisory label still on the PR is stale by construction — never re-derived from a stale head
      // comparison, just dropped alongside the gate it was scoped to. Live bug (PR #2578, 2026-09-24): a
      // `clear-human` at 13:38:11Z left `advisory:accepted` (stamped 13:29:54Z, while still `review:human`) sitting
      // on the PR through three more review rounds with no `review:human` left to explain it.
      removeLabels: [
        REVIEW_LABELS.human, REVIEW_LABELS.pending, REVIEW_LABELS.changes, REVIEW_LABELS.redteamAccepted,
        ADVISORY_LABELS.ACCEPTED, ADVISORY_LABELS.CHANGES,
      ],
      keepsHuman: false,
      reason: 'gate-self CLEARED via --to=clear-human — review:human dropped, review:accepted added; drain may merge',
    };
  }

  // we:scripts/review-set-label.mjs#decideSetLabel — rearm (#2644, folded in from the old conveyor decideRearm).
  // The conveyor fix agent hands a repaired review:changes bounce back for re-review. ONLY a live review:changes
  // is re-armable (idempotent no-op otherwise — what makes a second call after the swap safe). The swap is ALWAYS
  // changes→pending, NEVER adds review:accepted, and NEVER removes review:human — the #2630 invariant, enforced
  // HERE in the pure core so the CLI cannot route around it.
  if (to === 'rearm') {
    if (!hasReviewLabel(currentLabels, REVIEW_LABELS.changes)) {
      return {
        allowed: false,
        addLabel: '',
        removeLabels: [],
        keepsHuman: isHuman,
        reason: 'no review:changes label — nothing to re-arm (the PR is not a bounce awaiting repair)',
      };
    }
    return {
      allowed: true,
      // #x01u7az — INVARIANT: at most ONE review:* HOLD label live at a time. `review:human` IS the hold on a
      // gate-self PR; `review:pending` is the hold on an ordinary one. Before this fix, re-arming a
      // `review:human` bounce added `review:pending` UNCONDITIONALLY, alongside the human hold that never came
      // off — the contradictory pair live on PR #2549 (2026-09-24): `review:pending` added 14:05:09Z by this
      // exact rearm path, on top of a `review:human` set 01:32:17Z and never cleared. A `review:human` PR is
      // ALREADY held; adding `review:pending` on top asserts a second, redundant hold and reads as "still
      // pending" to anything that doesn't know to check both. Only add `review:pending` when the PR is NOT
      // gate-self — the human hold on its own already says "an independent review is owed", so a rearm on a
      // `review:human` PR adds nothing.
      addLabel: isHuman ? '' : REVIEW_LABELS.pending,
      // #2832 — re-arm applies a review-hold (review:pending, or review:human alone), so it must atomically
      // strip ready-to-merge: a held PR may never carry the go-ahead. `presentRemoveLabels` narrows this to the
      // labels the PR actually carries, so naming ready-to-merge here is a no-op when it is absent.
      // #2412 review-fix — a re-arm hands a repaired bounce back for a fresh, independent re-review (the #2630
      // invariant this function enforces); same reasoning as the `changes` branch below applies to any stale
      // `redteam:accepted` the PR still carries from before the fix.
      removeLabels: [REVIEW_LABELS.changes, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL],
      keepsHuman: isHuman,
      reason: isHuman
        ? 're-armed — review:human KEPT as the sole hold (gate-self stays human-ceremony-only); review:pending '
          + 'NOT added — the human hold already says an independent review is owed (#x01u7az)'
        : 're-armed — review:changes→review:pending; drain AI-review (or a human) re-verdicts',
    };
  }

  // we:scripts/review-set-label.mjs#decideSetLabel — restamp (#x5e2ldj): carry an EXISTING acceptance across a
  // head the drain itself moved. It adds nothing and removes nothing — the label set is already right; what
  // went stale is the markers, and those are stamped by the write path, not by this decision.
  //
  // THE REFUSALS ARE THE WHOLE GUARD. A `restamp` that could CREATE an acceptance would be a strictly worse
  // `accepted`: one that skips INVARIANT 2, skips #2844's independence check, and claims a review nobody ran.
  if (to === 'restamp') {
    if (isHuman) {
      return {
        allowed: false, addLabel: '', removeLabels: [], keepsHuman: true,
        reason: 'gate-self: review:human is uncleared — a re-stamp carries an acceptance, it cannot complete one',
      };
    }
    if (!hasReviewLabel(currentLabels, REVIEW_LABELS.accepted)) {
      return {
        allowed: false, addLabel: '', removeLabels: [], keepsHuman: isHuman,
        reason: 'no review:accepted label — there is no acceptance to carry across the rebase',
      };
    }
    // A PR carrying BOTH `accepted` and `changes` is the self-contradictory pair #2974 exists to prevent, and
    // the pre-existing totality sweep caught this branch leaving it standing. REFUSE rather than strip:
    // `accepted` strips a stale `changes` because a reviewer just decided; a re-stamp decides nothing, so
    // resolving the contradiction in the acceptance's favour would be this target inventing a verdict.
    if (hasReviewLabel(currentLabels, REVIEW_LABELS.changes)) {
      return {
        allowed: false, addLabel: '', removeLabels: [], keepsHuman: isHuman,
        reason: 'review:accepted and review:changes are both live (#2974) — a re-stamp carries an acceptance, '
          + 'it does not adjudicate a contradictory one; re-review the PR',
      };
    }
    return {
      allowed: true,
      addLabel: REVIEW_LABELS.accepted,
      removeLabels: [],
      keepsHuman: isHuman,
      reason: 're-stamped — acceptance carried across a drain-authored rebase; no review was re-run',
    };
  }

  // we:scripts/review-set-label.mjs#decideSetLabel — INVARIANT 2: never clear review:human to accepted here.
  if (to === 'accepted' && isHuman) {
    return {
      allowed: false,
      addLabel: '',
      removeLabels: [],
      keepsHuman: isHuman,
      reason: 'gate-self: review:human is human-ceremony-only — clear via /review in a session',
    };
  }

  // we:scripts/review-set-label.mjs#decideSetLabel — accepted (no human gate): the reviewer accepted →
  // add review:accepted, drop the parked review:pending AND a stale review:changes (#2974). A PR reaching
  // `accepted` may have gotten there straight from `pending`, OR via a bounce that was fixed and re-verdicted
  // without going through `rearm` first — in either case `review:changes` must not survive next to
  // `review:accepted`. `changes` (below) already strips a stale `accepted`; `accepted` was the one asymmetric
  // target, under-clearing and leaving a self-contradictory label pair that three consumers
  // (`lane-resume.mjs#land`, `pr-watch.mjs`'s `PARK_LABELS`/`isReadyToLand`, `status-board.mjs#reviewLabelOf`)
  // read raw with no accepted-first ordering of their own. `presentRemoveLabels` narrows this to labels the PR
  // actually carries, so listing `changes` unconditionally never risks an absent-label error from `gh`.
  //
  // DELIBERATELY DOES NOT strip `redteam:accepted` (unlike `clear-human`/`changes`/`rearm` above) — this is the
  // one target the ordinary engine-tier happy path relies on: the independent hardened validator's
  // `redteam:accepted` and this reviewer's `review:accepted` are meant to be STACKED for the same head
  // (gate-invariants.test.mjs INVARIANT 14), in whichever order either sign-off lands first. Stripping it here
  // would make the two verdicts unable to ever coexist — accepting would immediately erase whatever redteam
  // sign-off just landed, permanently re-parking every engine-tier PR. The residual this leaves (a SILENT new
  // commit, no bounce/re-park in between, then a plain re-accept on a now-stale `redteam:accepted`) is real but
  // narrower and is tracked separately (`backlog/xy5uey0-…md`, needs `redteam:accepted` to earn its own
  // SHA-marker producer, #2896) rather than fixed by blanket-stripping here.
  if (to === 'accepted') {
    return {
      allowed: true,
      addLabel: REVIEW_LABELS.accepted,
      removeLabels: [REVIEW_LABELS.pending, REVIEW_LABELS.changes],
      keepsHuman: isHuman,
      reason: 'accepted — reviewer accepted; drain may merge',
    };
  }

  // ── THE REASONLESS-BOUNCE REFUSAL (#3334) ──────────────────────────────────────────────────────────────────
  // WHY IT IS HERE AND NOT IN A CALLER. #1572 put this rule in `we:scripts/operations/review-pr.mjs`'s `record`
  // step, which protects exactly the one route that runs it. The other two sanctioned write paths —
  // `we:scripts/operations/record-verdict.mjs` (the transport for a host that cannot authenticate to GitHub,
  // i.e. every cloud runner) and this file's own CLI — carried no such check, and a real reasonless bounce
  // landed on PR #1593: "✅ pass — no blocking findings … Findings (0) … _No findings._" directly above
  // "Decision: `changes`", with no reason anywhere. #2644 made this file the SINGLE HOME of the label swap and
  // INVARIANT 2 already lives here; the guard belongs beside it, where every route passes through it.
  //
  // A rule enforced in one caller of a single-home function is not enforced — it is merely usually encountered.
  //
  // THE NEGATIVE DIRECTION IS THE RISK, so the condition is as narrow as it can be (`isReasonlessBounce`): a
  // bounce carrying ANY finding needs no reason (the findings ARE the reason, and they are already rendered),
  // a bounce carrying a reason needs no findings, and an UNKNOWN finding count never refuses at all. A guard
  // that also blocked legitimate bounces would be worse than the hole it closes.
  if (isReasonlessBounce({ to, findingCount, reason })) {
    return {
      allowed: false,
      addLabel: '',
      removeLabels: [],
      keepsHuman: isHuman,
      reason: REASONLESS_BOUNCE_REFUSAL,
    };
  }

  // we:scripts/review-set-label.mjs#decideSetLabel — changes: a bounce is otherwise always allowed (regardless
  // of human/pending). It adds review:changes and drops BOTH review:pending AND a stale review:accepted (a
  // bounce must never leave the PR looking accepted), but NEVER removes review:human — a bounce lands nothing,
  // so the human gate stays until a human clears it.
  return {
    allowed: true,
    addLabel: REVIEW_LABELS.changes,
    // #2832 — a bounce applies a review-hold (review:changes), so it must atomically strip ready-to-merge too
    // (alongside the stale pending/accepted): a held PR may never carry the go-ahead. `presentRemoveLabels`
    // narrows to what the PR actually carries, so listing ready-to-merge is a no-op when it is absent.
    // #2412 review-fix (adversarial round 1, finding 3) — ALSO strips a stale `redteam:accepted`: that label
    // carries no SHA/fingerprint of its own (unlike `review:accepted`'s `acceptanceCoversHead` apparatus — the
    // independent validator's producer plumbing is #2896's still-open concern), so nothing else in the gate can
    // tell a `redteam:accepted` that covers THIS diff from one left over from before a bounce sent it back for
    // changes. A bounce is the one unambiguous "this diff is not good as-is" signal available today; leaving the
    // old sign-off in place would let a re-accept after the fix ride on a validator verdict that never saw it.
    removeLabels: [REVIEW_LABELS.pending, REVIEW_LABELS.accepted, REVIEW_LABELS.redteamAccepted, READY_TO_MERGE_LABEL],
    keepsHuman: isHuman,
    reason: 'changes — author lane fixes hot-context and re-pushes',
  };
}

/**
 * we:scripts/review-set-label.mjs#presentRemoveLabels — narrow a decision's `removeLabels` to only those the PR
 * ACTUALLY carries, so `gh pr edit --remove-label` is never handed an absent label (which errors). Pure — the
 * CLI intersects the decider's superset of removals against the observed labels before shelling out. Order and
 * de-dup follow `removeLabels`.
 * @param {string[]} removeLabels - the decision's requested removals
 * @param {Array} currentLabels - the PR's OBSERVED labels (string or `{name}` shape, per `hasReviewLabel`)
 * @returns {string[]}
 */
export function presentRemoveLabels(removeLabels, currentLabels) {
  return (Array.isArray(removeLabels) ? removeLabels : []).filter((l) => hasReviewLabel(currentLabels, l));
}

/**
 * WHERE A `--body-file` MAY LIVE (#2897). PURE over injected roots, so both directions are testable.
 *
 * THE GUARD STAYS; ONLY THE ALLOWLIST WIDENS. The file's contents are published to a PUBLIC PR and cannot be
 * unpublished, so an unconstrained path turns a review CLI into an exfiltration primitive. That is why the
 * check exists and why this does not remove it.
 *
 * WHAT WAS WRONG WITH IT: the roots were `process.cwd()` and `tmpdir()` compared as written. On macOS
 * `tmpdir()` is a PER-USER folder under `/var/folders/…`, so the conventional shared `/tmp` was refused — and
 * so was an agent session scratchpad. `/tmp` is itself a symlink to `/private/tmp` there, so even naming the
 * real temp dir could be refused on SPELLING. A caller who cannot use the sanctioned flag hand-rolls a
 * comment instead, which is precisely the bypass #2882 was built to close: a usability defect that pushes
 * people off the safe path is a safety defect one step removed.
 *
 * SYMLINKS ARE RESOLVED ON BOTH SIDES, and the target side resolves its DEEPEST EXISTING ANCESTOR before
 * rejoining the tail that does not exist yet. The file need not exist — reporting "outside the allowlist" for
 * a missing one would name the wrong problem, and the unreadable-file error downstream is clearer — but a
 * path whose parents are also missing must still be compared in resolved form, or a caller writing to a fresh
 * scratch directory under a symlinked root is refused on spelling. A root that does not resolve is dropped
 * rather than compared as written, so a platform without `/tmp` simply has one fewer root.
 *
 * @param {string} abs - the already-resolved absolute path to the body file.
 * @param {string[]} roots - candidate root directories.
 * @returns {{ok: true} | {ok: false, roots: string[]}}
 */
export function checkBodyFileLocation(abs, roots) {
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  // RESOLVE THE DEEPEST ANCESTOR THAT EXISTS, then rejoin the tail that does not. Resolving only the immediate
  // parent left the literal path whenever an intermediate directory was absent — and a LITERAL path compared
  // against RESOLVED roots is exactly the spelling mismatch this widening exists to end: on macOS
  // `/tmp/scratch/verdict.md` under a not-yet-created `scratch/` was refused against a root resolved to
  // `/private/tmp` (review-pr correctness juror on PR #1495). A caller writing to a fresh scratch directory is
  // the ordinary case, not an exotic one.
  const resolveDeepest = (p) => {
    const tail = [];
    for (let dir = p; ; dir = dirname(dir)) {
      const hit = real(dir);
      if (hit) return tail.length ? join(hit, ...tail.reverse()) : hit;
      if (dirname(dir) === dir) return p;   // walked to the root and nothing resolved
      tail.push(basename(dir));
    }
  };
  const allowed = [...new Set(roots.map(real).filter(Boolean))];
  const target = resolveDeepest(abs);
  const ok = allowed.some((root) => target === root || target.startsWith(root + sep));
  return ok ? { ok: true } : { ok: false, roots: allowed };
}

/** The roots a `--body-file` may sit under. `/tmp` is listed EXPLICITLY because on macOS it is neither
 *  `tmpdir()` nor a prefix of it, and it is where callers actually write. */
export const bodyFileRoots = (cwd = process.cwd(), tmp = tmpdir()) => [cwd, tmp, '/tmp'];

/**
 * #3690 — PR #2313's SECOND review bounce: appending to a TRACKED store is not publishing a trial.
 * An uncommitted row in the reviewer's checkout can disappear on reset and never informs another
 * checkout's graduation/dedupe reads. Mirror lane-drain.mjs's quietGit/publishMain convention: commit
 * ONLY the scorecard path, then publish its exact SHA through push-if-green.mjs (scoped gate, ff-only, #2073).
 * Guard HEAD BEFORE committing; the push helper's own branch refusal would be too late to prevent a
 * bookkeeping commit on a lane ref. Resolve the helper from THIS module, but target the injected repo.
 * Acceptance has already succeeded. Every git/publish failure returns evidence for the caller's loud
 * recovery warning, never an exception that could turn a completed accept into a failed verdict.
 */
export function publishDelegationTrialCommit({ provider, model, taskType, pr, cwd } = {}) {
  let committed = false;
  let stage = 'could not resolve repo root';
  const firstLine = (e) => String((e && (e.stderr || e.message)) || e).trim().split('\n')[0];
  try {
    const options = { cwd: cwd ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim();
    options.cwd = repoRoot;
    stage = 'could not resolve HEAD';
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], options).trim();
    if (branch !== 'main') {
      return { committed: false, pushed: false, reason: `HEAD is "${branch}", not "main" — the scorecard row must land on shared main, never a lane branch; commit skipped` };
    }
    stage = 'could not fetch origin/main';
    execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], options);
    stage = 'could not compare main to origin/main';
    const local = execFileSync('git', ['rev-parse', 'main'], options).trim();
    let remote = null;
    try { remote = execFileSync('git', ['rev-parse', 'origin/main'], options).trim(); } catch { /* no tracking ref yet — nothing to compare */ }
    if (remote && local !== remote) {
      return { committed: false, pushed: false, reason: `local main (${local.slice(0, 8)}) differs from origin/main (${remote.slice(0, 8)}) — refusing to publish on diverged history; commit skipped` };
    }
    stage = 'git commit failed';
    const message = `conveyor: log ${provider}/${model} ${taskType} trial for PR #${pr} (#3690)`;
    execFileSync('git', ['commit', '-m', message, '--', 'scripts/conveyor/run-scorecards.json'], options);
    committed = true;
    stage = 'could not resolve committed HEAD';
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    stage = 'push-if-green.mjs failed';
    const pushIfGreen = join(dirname(fileURLToPath(import.meta.url)), 'push-if-green.mjs');
    // appendScorecard/logDelegationTrial already fully validate the row (schema, enums, secret scrub),
    // throwing before this function is reached: this gate cannot be protecting against a bad row.
    // The commit is pathspec-scoped to this one non-code JSON file (the "commits only the scorecard"
    // test proves it); no build consumer depends on it in a way a full lint/test run adds coverage for.
    // The only residual gate risk is regression in this commit/push code path, run-scorecard-store.mjs,
    // or log-delegation-trial.mjs, directly and fully exercised by these three suites. Every PR,
    // including this change, still runs FULL test:unit && check:standards in CI before merge.
    // This is a separate best-effort, non-fatal, post-merge single-file side-effect publish, not a code merge.
    const gate = 'npm run test:unit -- scripts/__tests__/review-set-label.test.mjs scripts/conveyor/__tests__/run-scorecard-store.test.mjs scripts/conveyor/__tests__/log-delegation-trial.test.mjs';
    const out = execFileSync(process.execPath, [pushIfGreen, `--repo=${repoRoot}`, `--sha=${sha}`, `--gate=${gate}`, '--json'], { ...options, env: { ...process.env, MAIN_PUSH_OK: '1' } });
    const parsed = JSON.parse(out.trim());
    return { committed, pushed: !!parsed.pushed, reason: parsed.detail || parsed.reason };
  } catch (e) {
    // publishMain's non-zero-exit convention: the refusal is still JSON on stdout, not stderr.
    if (committed) {
      try {
        const parsed = JSON.parse(String(e?.stdout || '').trim());
        return { committed, pushed: !!parsed.pushed, reason: parsed.detail || parsed.reason || `${stage}: ${firstLine(e)}` };
      } catch { /* no JSON result — report the subprocess failure below */ }
    }
    return { committed, pushed: false, reason: `${stage}: ${firstLine(e)}` };
  }
}

/**
 * we:scripts/review-set-label.mjs#decideRestampHumanClearance — #x9krtkb: does THIS restamp owe a carried human
 * clearance? PURE, extracted from `runReviewLabelCli`'s inline call site for the same reason
 * `shouldReparkForTestTampering` was pulled out of its own inline call site in
 * `we:scripts/lib/review-escalation.mjs`: the DECISION, not just the marker parsing beneath it, needs its own
 * unit tests, and there is no end-to-end drain fixture this repo runs that could exercise it otherwise.
 *
 * THE BUG THIS CLOSES, live on PR #2572 (2026-09-24): a human ran `--to=clear-human`; the drain's own
 * content-preserving rebase moved the head a minute later; the drain's `restamp` carried `reviewed-sha` /
 * `reviewed-diff` / `reviewed-contribution` forward but never `cleared-human` — because the restamp path had no
 * visibility into the PR's comments at all (see `we:scripts/lib/review-label-provider.mjs`'s `PR_STATE_FIELDS`,
 * which now includes `comments`). The next drain pass's anti-test-gaming gate
 * (`shouldReparkForTestTampering`/`parseLatestHumanClearedSha`, both in `we:scripts/lib/review-escalation.mjs`)
 * then saw the LATEST accept-shaped comment (the restamp itself) carrying no human coverage and re-parked
 * `review:human` — undoing the clearance on every rebase, forever.
 *
 * Returns non-null (the carry is owed) ONLY when BOTH:
 *   1. the LATEST accept-shaped comment on the PR was itself a `--to=clear-human` ceremony
 *      (`parseLatestHumanClearedSha` — bound to THAT ONE comment, never an older clearance a later plain accept
 *      could otherwise inherit; see that function's own docstring for why the binding matters), AND
 *   2. the content that clearance covered is PROVABLY unchanged at the new head — reusing
 *      `acceptanceCoversHead`'s existing diff/contribution-equivalence escape (#x169fqe/#x9xqexm) rather than
 *      trusting the caller's own "this was a content-preserving rebase" classification a second time. The SHA
 *      branch of that check never fires here (a restamp exists BECAUSE the head moved relative to the accepted
 *      one), so this is always the diff-or-contribution escape — the exact mechanism `restamp` was built around,
 *      now also gating the marker carry.
 *
 * FAILS CLOSED, like everything else `restamp` touches: a missing/unparseable fingerprint on either side falls
 * straight through `acceptanceCoversHead` to `covers: false`, so an unproven case returns `null` — no human
 * marker is minted, matching `decideSetLabel`'s own restamp posture (it can carry an acceptance forward, never
 * invent one). A restamp of a PLAIN agent accept never even reaches the coverage check: `humanClearedSha` is
 * `null` for it, so this returns `null` immediately — a restamp of a plain accept ALWAYS stays plain.
 *
 * @param {{comments:Array, headSha:string, headDiff:string}} o - `comments` is the PR's raw `gh pr view
 *   --json comments` array. `headSha` is the head this restamp is stamping (post-#x9krtkb bug-2 fix, the
 *   caller-asserted `--new-head` when supplied, never a racy re-read). `headDiff` is the FRESH net diff text (or
 *   precomputed fingerprint) this restamp already computed against that head, reused rather than re-fetched.
 * @returns {{actor:string, sha:string}|null}
 */
export function decideRestampHumanClearance({ comments, headSha, headDiff } = {}) {
  const humanClearedSha = parseLatestHumanClearedSha(comments);
  if (!humanClearedSha) return null;
  const coverage = acceptanceCoversHead({
    acceptedSha: humanClearedSha,
    headSha,
    acceptedDiff: parseReviewedDiff(comments),
    headDiff,
    acceptedContribution: parseReviewedContribution(comments),
    headContribution: headDiff,
  });
  if (!coverage.covers) return null;
  const clearance = parseOperatorClearance(comments);
  return { actor: clearance ? clearance.actor : 'the operator', sha: humanClearedSha };
}

/**
 * we:scripts/review-set-label.mjs#runReviewLabelCli — the SHARED review-label CLI harness (#2644). Both this
 * file's reviewer-verdict CLI and the conveyor `rearm-review.mjs` run this SAME observe→decide→write→re-read arc
 * against `gh`; only three things differ and they arrive as config (exactly the deltas #2644 names):
 *   • `defaultActor` — who the durable comment is attributed to;
 *   • `buildComment({ to, actor, decision }) => string` — the comment body;
 *   • `repoOptional` — when true a missing `--repo` is derived from the cwd repo (`gh repo view`; the fix agent
 *     runs inside its own lane clone, so cwd IS the PR's repo); when false `--repo` is required.
 * `fixedTo` pins the verdict (rearm) or, when null, the harness parses + validates `--to` (accepted/changes).
 * The printed payload shapes stay the caller's, via `successResult`/`refusalResult`. Impure (shells gh); the
 * PURE `decideSetLabel` above owns every invariant, so this harness only moves bytes.
 *
 * Fails closed on INPUT — every input is validated BEFORE any gh mutation. It does NOT promise atomicity, and
 * saying it did was false (#2964): the swap and the durable comment are two non-atomic `gh` calls, so a gh error
 * between them exits non-zero with ONE of the two already landed. What #2964 bought is that the half left behind
 * is the SAFE one to lose — comment first on a PR that is not yet accepted (an orphan marker is never read), swap
 * first on one that already is (an orphan marker there would freshen the #2409 gate's coverage for an acceptance
 * that never landed). See the ordering block in the body for the full argument; the seam is not sealed, only
 * pointed the safe way.
 *
 * `allowClearHuman` is the opt-in for the #2895 gate-self clearance. SAY WHAT IT ACTUALLY IS (PR #1056 review,
 * round 4 — the earlier wording over-claimed): it binds IMPORTERS ONLY, and today it binds nobody. This file's
 * own `IS_CLI` block passes `true` unconditionally, so EVERY shell caller of this CLI is opted in and the flag
 * constrains nothing on a command line. The one importer of this harness, `we:scripts/conveyor/rearm-review.mjs`,
 * pins `fixedTo: 'rearm'` and so could never reach `clear-human` by relaying an argv anyway; and nothing else
 * reaches the target at all — `we:scripts/lib/auto-land-seam.mjs#buildSetLabelArgs` builds a literal
 * `--to=accepted`. What the boolean buys is narrow and forward-looking: a FUTURE importer that forwards argv it
 * did not vet (the #2945 console is the next candidate) cannot land on `clear-human` unless it names the
 * capability in its own source, where a reviewer reads it. It is NOT a trust boundary and NOT a barrier — it is
 * an ordinary parameter of an exported function, so an importer that wants it just passes it. That is accepted,
 * because #2895 ruled the unforgeable signal deferred (file header); the mitigation is the honesty tax below,
 * not this boolean. It is deliberately a DUMB BOOLEAN rather than an injected predicate — a caller may declare a
 * capability, never supply a verdict (PR #1056 review, B2).
 * @param {{argv?:string[], fixedTo?:string|null, defaultActor:string, repoOptional?:boolean, usage:string,
 *   allowClearHuman?:boolean,
 *   buildComment:(o:{to:string,actor:string,decision:object,headSha:string,reason:string,
 *     humanClearance?:{actor:string,sha:string}|null})=>string,
 *   successResult:(o:{pr:number,to:string,decision:object,labels:string[]})=>object,
 *   refusalResult:(o:{pr:number,decision:object})=>object,
 *   emit?:(line:string)=>void}} cfg
 *
 * `emit` is the stdout writer, and it is INJECTED for one reason (#3061): the production default drains
 * SYNCHRONOUSLY (`writeAllSync`), because `write(payload); process.exit()` truncates to the pipe buffer when a
 * parent captures stdout. A synchronous `fs.writeSync(1, …)` is invisible to a test that captures by
 * monkey-patching `process.stdout.write` — and it should be: that patch never touched a pipe, so it could
 * never have caught the truncation it looks like it is testing. An in-process caller passes its own collector
 * instead of pretending to own fd 1.
 */
export function runReviewLabelCli({
  argv = process.argv.slice(2),
  fixedTo = null,
  defaultActor,
  repoOptional = false,
  usage,
  buildComment,
  successResult,
  refusalResult,
  allowClearHuman = false,
  // The findings write-up, so this function can REFUSE an empty bounce (see the `--to=changes` guard below).
  // The rendered comment still gets its body from the caller's `buildComment` closure — this is the same text,
  // handed over separately so the refusal lives with the other pre-flight validation instead of in one CLI
  // shell that no in-process caller runs. A caller that omits it is treated as having supplied nothing.
  verdictBody = '',
  emit = (line) => writeAllSync(1, line),
  // THE FORGE SEAM (#x8xf5rl). Defaults to `gh`, byte-identical to the inline calls this replaced.
  // Injected so the WRITE ARC — above all the #2964 ordering below — is assertable without `gh`,
  // which it never was: the suite could only reach this function's pure helpers and its refusals.
  provider = createGhProvider(),
  readTrialStore = readStore,
  logTrialFn = logDelegationTrial,
  publishTrialFn = publishDelegationTrialCommit,
  trialLogIo = {},
} = {}) {
  // Shadows the module-level `fail` so EVERY refusal inside this function — there are seventeen — goes to the
  // injected emitter too. Without this the guards print past an in-process caller's collector (#3061); the
  // module-level one stays for the CLI bootstrap below, which owns fd 1 for real.
  const fail = (message, code = 2) => { emit(`${JSON.stringify({ error: message })}\n`); process.exit(code); };
  let repo = (argv.find((a) => a.startsWith('--repo=')) || '').slice('--repo='.length);
  const actorArg = (argv.find((a) => a.startsWith('--actor=')) || '').slice('--actor='.length);
  const actor = actorArg || defaultActor;
  const clearReason = (argv.find((a) => a.startsWith('--reason=')) || '').slice('--reason='.length).trim();
  // #3007 — the SURFACE, read here so the ledger row can record it. The rendered COMMENT gets its channel
  // from the caller's `buildComment` closure (#2898); this read is only for the durable row, and it is the
  // same argv flag, so the two can never name different surfaces.
  const channelArg = (argv.find((a) => a.startsWith('--channel=')) || '').slice('--channel='.length);
  const pr = argv.find((a) => /^\d+$/.test(a));
  const to = fixedTo || (argv.find((a) => a.startsWith('--to=')) || '').slice('--to='.length);
  // #x9krtkb (bug 2) — `restamp`'s ONE caller (`restampAcceptance`, `we:scripts/merge-ai-prs.mjs`) already knows
  // the exact new head: it is the drain's OWN `git push`, computed locally, not a re-read. Before this it threw
  // that value away past `--reason`'s free text and let `runReviewLabelCli` re-derive the head from a fresh
  // `gh pr view` a few lines below — which races GitHub's OWN propagation of the push it had just accepted.
  // Observed live on PR #2572 (2026-09-24): a restamp six seconds after the push still read the PRE-rebase head.
  // `--new-head` is the fix: an explicit, caller-asserted override that WINS over the re-read for `restamp`
  // only. Optional and validated here (fail closed on a malformed SHA) so a caller who does not have it yet —
  // there are none in this repo, but nothing stops a future one — still gets the pre-#x9krtkb re-read fallback.
  const newHeadArg = (argv.find((a) => a.startsWith('--new-head=')) || '').slice('--new-head='.length).trim();

  // we:scripts/review-set-label.mjs#runReviewLabelCli — validate every input BEFORE any gh call (fail closed).
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  if (!pr || !/^\d+$/.test(pr) || Number(pr) <= 0) {
    fail(usage);
  }
  // A PRESENT --repo is ALWAYS validated up front (a typo fails closed before any gh call), whether or not
  // --repo is optional. An ABSENT --repo fails here only when it is REQUIRED; when optional it is derived below.
  if (repo ? !REPO_RE.test(repo) : !repoOptional) {
    fail('invalid --repo — expected <owner/name>');
  }
  if (newHeadArg && !/^[0-9a-f]{7,40}$/i.test(newHeadArg)) {
    fail('invalid --new-head — expected a git commit SHA (7-40 hex chars)');
  }
  // #2895 — every `clear-human` precondition is checked HERE: unconditionally, at the point of use, BEFORE any
  // gh call, and refusing through the `{"error":…}` JSON contract every other refusal here honours. Not folded
  // into the `!fixedTo &&` argv branch below — PR #1056 review, m1: a caller pinning `fixedTo: 'clear-human'`
  // skipped that branch entirely and blew up later with a TypeError instead of a clean refusal.
  if (to === 'clear-human') {
    // The opt-in. An accident guard — see `allowClearHuman` above for exactly how far it goes (not far).
    if (!allowClearHuman) {
      fail(
        '--to=clear-human is for the operator-run CLI in review-set-label.mjs (#2895) — this caller did not '
        + 'opt in, and nothing was changed',
      );
    }
    // THE HONESTY TAX (#2895). The unforgeable actor signal is deferred, so the only thing standing between a
    // clearance and a fabricated one is that the record has to be WRITTEN. Both fields are mandatory and both
    // land in the durable comment: a clearance nobody authorised now requires inventing a name AND inventing a
    // quoted instruction, which is a far brighter line than quietly adding a label. `we:skills-src/review/`
    // `SKILL.md` binds the agent side: `--reason` must quote the operator's in-conversation instruction.
    if (!actorArg.trim()) {
      fail(
        '--to=clear-human requires an explicit --actor=<name> — the clearance record must name who asked for '
        + 'it, and the default actor is not an answer (#2895)',
      );
    }
    if (!clearReason) {
      fail(
        '--to=clear-human requires --reason=<stated reason> — quote the operator instruction authorising this '
        + 'clearance; it is posted verbatim in the durable comment (#2895)',
      );
    }
  }
  // A BOUNCE WITH NO FINDINGS IS UNACTIONABLE, so it is refused (#xd6moh1). `review:changes` tells the author
  // to fix something; the findings are the only place that says WHAT. Without them the PR is parked behind a
  // hold nobody can clear, because clearing it means addressing what was never written down. Seen live on
  // PR #1178, twice in one afternoon: two reviewers set the label and neither wrote a body.
  //
  // ONLY ON `changes`, and the asymmetry is the point. An accept with no body is merely TERSE — the label
  // already carries the whole meaning, "nothing to do". A bounce with no body carries NONE of its meaning.
  // Same shape as the `--reason` requirement above: the useless path has to take an explicit act, not a
  // silence.
  if (to === 'changes' && !String(verdictBody || '').trim()) {
    fail(
      '--to=changes requires the findings — pass --body-file=<path> with what the author has to fix. A bounce '
      + 'with no findings parks the PR behind a hold nobody can clear (#xd6moh1); nothing was changed.',
    );
  }
  const targets = allowClearHuman ? "'accepted', 'changes', or 'clear-human'" : "'accepted' or 'changes'";
  const targetOk = to === 'accepted' || to === 'changes' || to === 'clear-human' || to === 'restamp';
  if (!fixedTo && !targetOk) {
    fail(`invalid --to — expected ${targets}`);
  }
  // #2974 — `rearm` is DELIBERATELY still absent from this list. Before this item, a reviewer clearing a
  // bounced-but-now-fixed PR had no sanctioned path: `--to=accepted` left the stale `review:changes` behind
  // (the bug this item fixes), and `rearm` only swaps `changes → pending` (an independent re-review owed, per
  // the #2630 invariant) — it can never emit `review:accepted`, so exposing it here would not have solved the
  // reviewer's problem even if it had been reachable. Now that `accepted` drops `changes` itself, the reviewer's
  // actual want — "clear this fixed, bounced PR" — is `--to=accepted`, same as any other parked PR; no second
  // path is needed. `rearm` stays reachable only where it already was: `scripts/conveyor/rearm-review.mjs`
  // (`fixedTo: 'rearm'`), for the conveyor fix agent handing a repair back for re-review, a DIFFERENT actor and
  // a different intent (never-accept) from a reviewer's verdict. Opening `--to=rearm` here would let this CLI's
  // caller re-park an accepted-track PR without ever verdicting it — a capability nobody asked for and the item
  // said not to add both.

  // we:scripts/review-set-label.mjs#runReviewLabelCli — --repo optional: default to the cwd repo (the fix agent
  // runs inside its WE lane clone, so the current repo IS the PR's repo). Derived once, up front.
  if (repoOptional && !repo) {
    try {
      repo = provider.currentRepo();
    } catch (e) {
      fail(ghErr(e, 'gh repo view failed (pass --repo=<owner/name> explicitly)'), 1);
    }
    if (!REPO_RE.test(repo)) {
      fail('invalid --repo — expected <owner/name>');
    }
  }

  // we:scripts/review-set-label.mjs#runReviewLabelCli — observe the PR's current labels + head SHA (the I/O
  // boundary). #2409 — `headRefOid` is the tree the reviewer is looking at RIGHT NOW; on an `accepted` verdict
  // the reviewer-verdict comment stamps it (`buildReviewedShaMarker`) so the drain can refuse to honour the
  // acceptance later if the head advances past it. #2953 — `state` rides the SAME call (one more json field, no
  // extra gh hop) so a verdict on an already-merged/closed PR can fail closed below instead of silently reporting
  // `{"ok":true}` for a label write that landed on an inert, already-decided PR.
  let currentLabels;
  let headSha = '';
  let headRefName = '';
  let prState = '';
  let prBody = '';
  let prTitle = '';
  let prCreatedAt = '';
  let prComments = [];
  try {
    const parsed = provider.readPrState(repo, pr);
    currentLabels = Array.isArray(parsed.labels) ? parsed.labels : [];
    headSha = typeof parsed.headRefOid === 'string' ? parsed.headRefOid : '';
    // #2979 — the branch name the NET diff is resolved against (see the fingerprint block below). Same gh call,
    // one more json field, no extra hop.
    headRefName = typeof parsed.headRefName === 'string' ? parsed.headRefName : '';
    prState = typeof parsed.state === 'string' ? parsed.state : '';
    // #2844 — the PR body carries the `authored-by-actor` stamp pr-land wrote at open. Same gh call, one more
    // json field, no extra hop — the same "ride the existing read" pattern #2953 used for `state`.
    prBody = typeof parsed.body === 'string' ? parsed.body : '';
    prTitle = typeof parsed.title === 'string' ? parsed.title : '';
    // #3067 — and its open date, on that same call. A stamp missing from a PR opened AFTER the regime began was
    // STRIPPED; one missing from an older PR was never written. Until this was read, both looked identical and
    // both were tolerated.
    prCreatedAt = typeof parsed.createdAt === 'string' ? parsed.createdAt : '';
    // #x9krtkb — the restamp path's own read-back (see the import note above). Read unconditionally, off the
    // SAME call, for every target: it costs nothing extra to parse a field already in the response, and a
    // conditional read here would be the second copy of "which targets need comments" for no reason.
    prComments = Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch (e) {
    fail(ghErr(e, 'gh pr view failed'), 1);
  }

  // #x9krtkb (bug 2) — THE OVERRIDE. `restamp` alone trusts an explicit `--new-head` over the `headRefOid` this
  // process just re-read, because for `restamp` alone that read can be racing the very push that produced the
  // value it is supposed to confirm (see the flag's own docstring above). Every other target has no caller that
  // could supply a fresher truth than `gh` itself, so they are untouched — this is not a general "trust the
  // caller over the forge" change, it is narrowed to the one target and the one input this was proven wrong for.
  if (to === 'restamp' && newHeadArg) {
    headSha = newHeadArg.toLowerCase();
  }

  // #2953 — FAIL CLOSED on anything but an OPEN PR. Every sanctioned caller (the hand-run `/review` skill, the
  // conveyor's `rearm-review.mjs`, and `auto-land-seam.mjs`'s `defaultWriteAccept`, which applies `accepted`
  // BEFORE the merge itself) only ever swaps a label on a PR that is still open — so this cannot break a
  // legitimate caller. What it stops: a verdict posted on a PR the drain already merged (observed on WE PR #1073
  // — `review:changes` landed six minutes after `mergedAt`) used to report `{"ok":true}`, which reads as a live
  // bounce the drain ignored when in fact the merge gate was never involved. The findings belong on a NEW PR, not
  // on the merged one.
  //
  // #xwp8ioh — the predicate and its wording now live in `we:scripts/lib/pr-liveness.mjs`, imported rather
  // than restated here, because `we:scripts/operations/review-pr.mjs` gained the SAME check at its `read`
  // step and two copies of one rule is the drift #2644 forbids. The behaviour at THIS site is unchanged: any
  // non-OPEN state still fails closed with the same sentence and the same exit code. What moved forward is
  // WHEN it first fires — the read side now refuses before a juror is paid, so this write-side guard becomes
  // the backstop it should always have been rather than the only line of defence.
  const liveness = classifyPrLiveness({ state: prState });
  if (liveness.outcome !== 'reviewable') {
    fail(inertPrMessage({ pr, state: liveness.state }), 1);
  }

  // #2844 — THE SELF-CLEAR REFUSAL. Independence is EVALUATED for both targets that record an acceptance
  // (`accepted`, `clear-human`) so the durable comment can state the outcome either way; a `changes` bounce and a
  // `rearm` land nothing, so neither needs an independence bar at all. Checked HERE: after the OPEN-state gate,
  // BEFORE the pure decision and therefore before ANY gh mutation, and refusing through the same `{"error":…}`
  // JSON contract every other refusal here honours.
  //
  // ONLY `--to=accepted` — the AGENT verdict path — is REFUSED, and only on a PROVEN self-clear. Two separate
  // narrowings, each with its own reason:
  //   • the two "cannot establish it" statuses PROCEED and say so verbatim in the durable comment
  //     (`buildVerdictComment`). That asymmetry with the autonomous seam (`we:scripts/lib/auto-land-seam.mjs`,
  //     which refuses all three) is argued in full in `we:scripts/lib/review-independence.mjs`'s header:
  //     refusing `unknown-author` HERE would strand every PR opened before the stamp existed with no way for a
  //     HUMAN to clear it, which trades a real hole for a worse one.
  //   • `clear-human` is EXEMPT (PR #1100 review, THE BLOCKER). The comparison is SESSION-level — a subagent
  //     inherits its parent's `CLAUDE_CODE_SESSION_ID` — and the operator's `/review` ceremony shells this CLI
  //     from inside the session that opened the PR, so refusing `clear-human` too refused the operator's entire
  //     normal workflow and left NOTHING clearable through the sanctioned path. The exemption costs nothing the
  //     guard was buying, because `clear-human` already carries a stronger human signal than a session id: it is
  //     refused unless the PR actually carries `review:human` (`decideSetLabel`, below — that refusal still
  //     stands and is reached precisely because this one no longer fires first), and it demands an explicit
  //     `--actor` plus a quoted `--reason`. `buildVerdictComment` RECORDS the exemption, so the trail says a
  //     human ceremony cleared it rather than an established-independent agent.
  const clearerId = currentActorId();
  // `restamp` stamps the markers — carrying them across a head the drain moved is the entire point — but it is
  // EXCLUDED from the independence check: no clearer is asserting anything, so there is nobody to be
  // independent OF. The acceptance it carries already passed that check when it was earned.
  const stampsAcceptance = to === 'accepted' || to === 'clear-human' || to === 'restamp';
  const independence = (stampsAcceptance && to !== 'restamp')
    // #3067 WIRED HERE — the module's own header named this as the owed follow-up: the pure decider grew
    // `prCreatedAt` and `stampLostMarked` as OPT-IN inputs, and until a live caller passed them a stripped
    // stamp stayed indistinguishable from an absent one. Both are supplied now, so a post-regime PR with no
    // stamp resolves to STAMP_LOST (refused) instead of UNKNOWN_AUTHOR (tolerated).
    ? decideClearerIndependence({
      authorId: parseAuthorActorId(prBody),
      clearerId,
      prCreatedAt,
      stampLostMarked: hasStampLostMarker(prBody),
    })
    : null;
  if (to === 'accepted' && independence && independence.status === INDEPENDENCE.SELF_CLEAR) {
    // THE MESSAGE NAMES ONLY ROUTES THAT ACTUALLY WORK (PR #1100 review). The first cut inherited the decider's
    // "…or let a human clear it", which pointed at a door this same refusal had shut. There is deliberately NO
    // `--force` and no flag on this command: an agent recording an accept on its own session's PR is not an
    // independent review, and #2844 exists to stop that record being written as if it were.
    fail(
      `${independence.reason} — nothing was changed (#2844). TWO ROUTES ACTUALLY CLEAR THIS PR, and neither is a `
      + 'flag on this command. (1) THE HUMAN CEREMONY: if the PR carries review:human, re-run with '
      + '--to=clear-human --actor=<name> --reason="<the operator instruction authorising it>" — that target is '
      + 'EXEMPT from this refusal and the durable comment records the clearance as a human ceremony; it is itself '
      + 'refused when the PR does NOT carry review:human. (2) A DIFFERENT SESSION: run the review, and this '
      + 'command, from a session that did not open the PR — its own session id is then the clearing actor and the '
      + 'independence bar is genuinely met. There is no --force.',
      1,
    );
  }

  // we:scripts/review-set-label.mjs#runReviewLabelCli — the PURE decision. A refusal (INVARIANT 2, a reasonless
  // bounce, or nothing to re-arm) changes NOTHING and exits non-zero.
  //
  // #3334 — THE TWO DECISION INPUTS, READ OFF THE WRITE-UP THIS RUN IS ABOUT TO PUBLISH. They are computed here,
  // in the impure harness, and handed to the pure core as arguments; the core fetches nothing. `--reason` is
  // taken FIRST but the body's own quoted reason counts too, because the one caller that shells this CLI with a
  // reason (`we:scripts/operations/review-pr-io.mjs`'s label sink) renders it into the body and passes no
  // `--reason` flag at all — see `bounceEvidenceFromWriteUp`.
  const bounceEvidence = bounceEvidenceFromWriteUp(verdictBody);
  const decision = decideSetLabel({
    to,
    currentLabels,
    findingCount: bounceEvidence.findingCount,
    reason: clearReason || bounceEvidence.reason,
  });
  if (!decision.allowed) {
    emit(`${JSON.stringify(refusalResult({ pr: Number(pr), decision }))}\n`);
    process.exit(1);
  }

  // #x169fqe — capture the DIFF this verdict is being formed against, so the accept records WHAT was reviewed
  // and not merely WHICH COMMIT carried it. Without this the drain's own content-preserving rebase (the
  // manifest-drop pass, which fires within seconds of an accept) advances the head and invalidates the accept,
  // putting the queue in a re-review treadmill.
  //
  // THE NET DIFF, NOT `gh pr diff` (#2979 — the defect that made the first cut of this barely work). `gh pr diff`
  // returns the THREE-DOT diff, which still lists a sibling lane's file that has ALREADY landed on main as if
  // this PR added it (#2450 — the same phantom that burns negotiation rounds). Fingerprinting that means the
  // fingerprint changes every time ANY OTHER LANE LANDS, so an accept went stale for reasons having nothing to do
  // with this PR's content — measured on PR #1080, whose three-dot diff had grown to include four backlog items
  // and three script files from other PRs. `computeNetDiffText` is the repo's existing answer: the two-tree
  // `git diff <forkpoint> <head>`, content-only and ancestry-independent. Both SIDES of the comparison must use
  // it — this stamp and the drain's live read — or they are not comparing the same thing.
  //
  // FAIL-SOFT, DELIBERATELY: an unscored basis leaves `reviewedDiff` empty, so no marker is stamped and the gate
  // falls back to SHA identity — exactly the pre-#x169fqe behaviour, which is the STRICTER one. A read failure
  // can therefore only ever cost a false re-park, never honour an accept it should not. Computed only for a
  // verdict that actually records an acceptance, so a `changes` verdict pays nothing.
  let reviewedDiff = '';
  if (to === 'accepted' || to === 'clear-human' || to === 'restamp') {
    try {
      // `exec` MUST be execFileSync-shaped — `(cmd, argsArray, opts)`. Passing a shell-exec here is the exact
      // caller bug #2952 exists to make diagnosable: it throws a TypeError inside the try and degrades to an
      // unscored basis, which here silently costs the fingerprint. `execFileSyncThrottled` (#3631 slice) keeps
      // that exact shape and exact throw/return contract for the `cmd==='git'` calls this closure actually makes
      // — see the import site's header for why it is wired here anyway.
      //
      // NO EXPLICIT `cwd` HERE: THIS READS THE PROCESS'S OWN CWD, AND EVERY CALLER MUST GUARANTEE THAT IS THE
      // NAMED REPO'S CHECKOUT (PR #1087 review note 2; #3202). The original reasoning was that the CLI is
      // single-PR and operator-invoked, so it necessarily ran from the PR's repo — and it named the condition
      // that would break it: a caller passing a `--repo` that can name a repo other than the cwd's.
      //
      // THAT CALLER NOW EXISTS, so the rule is load-bearing rather than incidental. `restampAcceptance` in
      // `we:scripts/merge-ai-prs.mjs` shells this CLI with an explicit `--repo` while the drain sweeps three
      // repos in one process and never `chdir`s, and `restamp` is inside this very gate. It was spawned with no
      // `cwd` at first — precisely the wrong-tree fingerprint predicted here — and now pins the child to that
      // PR's clone, so the guarantee holds by construction instead of by the CLI happening to be run by hand.
      //
      // For the NEXT caller: run this CLI from the named repo's checkout, or pin the child process to it. A
      // `cwd` on this one call would not be enough — the `--body-file` allowlist is rooted at `process.cwd()`
      // too, so the process's location is the contract, not any single read's.
      const net = computeNetDiffText({
        exec: execFileSyncThrottled,
        rev: headRefName,
        fetchExtraRefs: headRefName ? [headRefName] : [],
      });
      reviewedDiff = net && net.scored ? net.text : '';
    } catch { reviewedDiff = ''; /* miss → no marker → SHA-identity fallback (the stricter path) */ }
  }

  // #x9krtkb (bug 1) — DOES THIS RESTAMP OWE A CARRIED HUMAN CLEARANCE? See `decideRestampHumanClearance`'s own
  // docstring for the full decision; only `to==='restamp'` ever asks (a plain accept/changes/clear-human has no
  // rebase to carry anything across).
  const humanClearance = to === 'restamp'
    ? decideRestampHumanClearance({ comments: prComments, headSha, headDiff: reviewedDiff })
    : null;

  // we:scripts/review-set-label.mjs#runReviewLabelCli — render the durable comment ONCE, here, so the bytes
  // that are size-checked, written and posted are the same bytes.
  const commentBody = buildComment({
    to, actor, decision, headSha, reason: clearReason, reviewedDiff, clearerId, independence, humanClearance,
  });

  // we:scripts/review-set-label.mjs#runReviewLabelCli — THE SIZE GUARD, on the RENDERED bytes, before ANY write.
  // GitHub rejects a comment over `GH_COMMENT_MAX`. The cause this guard exists for: an oversize comment used to
  // be discovered AFTER the swap had landed (the swap went first), leaving the PR `review:accepted` with NO
  // `reviewed-sha` marker, which `acceptanceCoversHead` fails OPEN on, and the drain then merged with the
  // staleness gate disarmed. #2964 reordered the writes, so on a first accept an oversize body can no longer
  // reach that state — but the guard EARNS ITS KEEP MORE, not less: checking here means an oversize comment now
  // fails before ANY write at all (no orphan record, nothing to re-run around), and on an ALREADY-accepted PR the
  // swap still goes first, so this is the only thing standing between an oversize body and the old partial state.
  // PR #1057 review: the only guard used to be an argv projection
  // sitting inside the CLI's `if (bodyFileArg)` branch, so a long `--reason` with no `--body-file` walked straight
  // around it (reproduced: `gh pr edit` succeeded, `gh pr comment` 422'd, and re-running `clear-human` then
  // refused — "nothing to clear" — so recovery needed the raw `gh pr comment` this whole item exists to forbid).
  // Checking HERE, where the bytes are produced, is what makes it unskippable: no call path — this CLI, the
  // `npm run review:clear` wrapper, or an importer supplying its own `buildComment` — can route around it. The
  // argv projection stays as belt-and-braces only because it can name the offending flag before any gh call.
  if (commentBody.length > GH_COMMENT_MAX) {
    fail(`the rendered comment is ${commentBody.length} chars, over GitHub's ${GH_COMMENT_MAX} limit — trim the body/--reason/--actor (nothing was changed)`);
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // #3007 PHASE 1 — THE LEDGER ROW, WRITTEN FIRST, THEN MIRRORED TO THE LABEL.
  //
  // WHY HERE AND NOT AFTER THE gh CALLS. #3007 says the ledger is written first, and this is the one point
  // where that is both possible and safe: EVERY refusal is already behind us — the argv validation, the
  // #2953 OPEN-state gate, the #2844 self-clear refusal, the pure `decideSetLabel` decision and the size
  // guard have all run and none of them can fire again. The only thing that can still fail below is `gh`
  // TRANSPORT, and a transport failure does not un-form the verdict: the reviewer decided, and the row says
  // so. What it costs is an orphan row with no label, which `we:scripts/review-ledger-check.mjs` reports as
  // `unlabeled` — a visible Phase-1 observation, which is exactly what this phase is for.
  //
  // THIS IS NOT IN CONFLICT WITH #3035's OPPOSITE ORDER, and the difference matters. The declared `review-pr`
  // operation (`we:scripts/operations/review-pr.mjs`) puts its ledger effect at ordinal 2, AFTER the label
  // effect, on the stated grounds that "an orphan row in the merge authority is NOT inert, so it must never
  // precede the label it vouches for". That is right THERE, because from outside this process the operation
  // cannot see the five refusals above — its effect 1 shells this CLI, which may still refuse. It is right
  // HERE too, one layer down, because at this line those refusals have already happened. The two orderings
  // are the same rule ("never write the row while a refusal is still reachable") applied at two seams; the
  // operation's own sink is therefore a RECONCILER, not a second writer (see review-pr-io.mjs).
  //
  // FAIL-SOFT ON THE LEDGER, DELIBERATELY: a ledger write failure does NOT abort the verdict. In Phase 1 the
  // ledger is shadow — nothing merges on it — so refusing an operator's verdict because a shadow file could
  // not be written would trade a real capability for an imaginary one. The miss goes to stderr (so it is
  // visible in a run log) and the checker reports the PR as `unledgered`. This posture MUST be revisited at
  // Phase 2, where a missing row means an un-mergeable PR rather than a missing observation.
  //
  // THE `to` → VERDICT MAPPING IS NOT WRITTEN HERE. It lives in `verdictForLabelTarget`
  // (`we:scripts/lib/verdict-ledger.mjs`) because the declared operation's reconciling sink has to derive the
  // SAME verdict from the SAME `to` to decide whether the row it finds is this round's row. A private copy of
  // the ternary here is what made that comparison unsound (PR #1149 review): the two sides must agree by
  // construction, not by both happening to be maintained.
  const ledgerVerdict = verdictForLabelTarget(to);
  try {
    const appended = appendVerdict(buildVerdictRecord({
      repo,
      pr: Number(pr),
      verdict: ledgerVerdict,
      at: new Date().toISOString(),
      // The operator's quoted `--reason` when there is one (the `clear-human` honesty tax), else the pure
      // decider's own reason — so a row always says WHY, from whichever source actually had a reason.
      reason: clearReason || decision.reason,
      // THE CONTENT WITNESSES — recorded, never used as the key. See the header of `lib/verdict-ledger.mjs`
      // for the two proven defects (#3046 gap divergence, `#3052` heading divergence, both open under
      // `#3054`) that make this digest unfit to FIND a record by, and fine to STORE beside one.
      headSha,
      reviewedDiff: normalizeDiffFingerprint(reviewedDiff),
      reviewedContribution: normalizeContributionFingerprint(reviewedDiff),
      declaredActor: actor,
      session: clearerId,
      channel: normalizeChannel(channelArg),
      independence: independence ? independence.status : null,
      source: 'review-set-label',
    }));
    if (!appended.ok) {
      process.stderr.write(`review-set-label: verdict-ledger append REFUSED (#3007 shadow) — ${appended.errors.join('; ')}\n`);
    }
  } catch (e) {
    process.stderr.write(`review-set-label: verdict-ledger append failed (#3007 shadow, non-fatal) — ${String((e && e.message) || e).split('\n')[0]}\n`);
  }

  // we:scripts/review-set-label.mjs#runReviewLabelCli — THE SWAP: add the verdict label, remove the stale ones
  // (argv array, no shell). Intersect the decision's removals with the labels the PR ACTUALLY carries so
  // `gh pr edit --remove-label` is never handed an absent label (which errors).
  const removals = presentRemoveLabels(decision.removeLabels, currentLabels);
  const applySwap = () => {
    try {
      provider.setLabels(repo, pr, { add: decision.addLabel, remove: removals });
    } catch (e) {
      fail(ghErr(e, 'gh pr edit failed'), 1);
    }
  };

  // we:scripts/review-set-label.mjs#runReviewLabelCli — THE DURABLE RECORD. Write the body to a temp file to dodge
  // shell-quoting pitfalls (emoji/newlines), then `--body-file`. This is the half that carries the `reviewed-sha`
  // (and `reviewed-diff`) marker the #2409 staleness gate reads.
  const postComment = () => {
    try {
      provider.postComment(repo, pr, commentBody);
    } catch (e) {
      fail(ghErr(e, 'gh pr comment failed'), 1);
    }
  };

  // #2964 — THE ORDER THESE TWO LAND IN IS THE SAFETY PROPERTY, and it is NOT the same order in both cases.
  //
  // They are two non-atomic `gh` calls with no rollback and no retry, so one of them can land alone. Which half is
  // SAFE TO LOSE depends on one thing: whether `review:accepted` is ALREADY live on this PR.
  //
  //   • NOT already accepted (the ordinary first accept, and every `changes` / `rearm` / `clear-human` bounce) —
  //     COMMENT FIRST. An orphan comment is INERT: `parseReviewedSha` is only ever reached behind a live
  //     `review:accepted` check (lazily, inside `if (hasReviewLabel(...accepted))` in `we:scripts/merge-ai-prs.mjs`,
  //     and again inside `decideReviewGate`'s accepted branch), so a marker with no label behind it is never read
  //     and the command stays re-runnable. An orphan LABEL is not inert: `review:accepted` with no marker makes
  //     `acceptanceCoversHead` fail OPEN, and the drain then merges with the #2409 staleness gate disarmed. Under
  //     the old edit-first order that was the reachable state — the exact hole this item was filed for.
  //
  //   • ALREADY accepted (the re-accept-after-a-fix flow: accepted at an older head, a commit rode in, the reviewer
  //     re-verdicts) — SWAP FIRST, the pre-#2964 order, deliberately kept HERE and only here. The swap degenerates
  //     to an idempotent `--add-label review:accepted`, so comment-first would post a marker naming the LIVE head
  //     while the acceptance is already live: `parseReviewedSha` takes the LATEST marker, `acceptanceCoversHead`
  //     flips to `covers: true`, and a run whose `gh pr edit` then FAILED would have FRESHENED the coverage of an
  //     acceptance it never applied — the drain lands a tree no successful swap vouched for. Swap-first keeps the
  //     marker on the swap side of that seam: a failed edit exits before the comment, the durable marker still
  //     names the OLD head, and the gate correctly re-parks. (Losing the comment after a successful swap here
  //     costs a RECORD, not the gate: the marker stays stale, which is the strict direction.)
  //
  // This is shape 1 from the item ("keep the marker on the swap side of the seam"), narrowed to the one case where
  // the marker is not inert. Shape 1 applied UNCONDITIONALLY — record first without the marker, swap, then stamp
  // the marker in a second comment — was rejected because it leaves the headline hole open: a failed marker post
  // after a successful swap is still `review:accepted` + no marker + fail-open. Shape 2 (refuse the run outright
  // when the PR is already accepted) was rejected because it removes the re-accept path the #2409 gate depends on
  // to un-stick a re-parked PR, and the item says that needs its own replacement.
  //
  // The test is keyed on the LABEL, not on `to`, on purpose: `buildComment` is caller-supplied, so this harness
  // cannot know whether a given importer's body stamps a marker. Assuming it might is the conservative direction.
  //
  // SAY WHAT THIS DOES NOT BUY: the act is STILL NOT ATOMIC. Two non-atomic calls remain two non-atomic calls —
  // this relocates the partial state onto the half that is safe to lose in each case, it does not eliminate it.
  // Closing it fully needs reconciliation or rollback, which is not what this is.
  // #x8xf5rl — the order now comes from the PURE `writeOrder`, so the property this block spends forty lines
  // explaining is finally assertable. The steps themselves are unchanged; only the choosing moved.
  const acceptanceAlreadyLive = hasReviewLabel(currentLabels, REVIEW_LABELS.accepted);
  const steps = { comment: postComment, swap: applySwap };
  for (const step of writeOrder({ acceptanceAlreadyLive })) { steps[step](); }

  // #3690 v1 deliberately records outcome:'landed'/findings:null for a CLEAN accept here.
  // A prior changes round must already have been fixed to reach this accept. Distinguishing clean on
  // round 1 from reworked then landed needs this PR's verdict-ledger.mjs history: separate follow-up,
  // out of scope here. Both real acceptance writes have completed before any trial is recorded.
  if (to === 'accepted' && normalizeChannel(channelArg) === REVIEW_PR_CHANNEL) {
    try {
      const delegation = parseDelegationMarker(prBody);
      const trialStore = delegation ? readTrialStore(trialLogIo) : null;
      const alreadyLogged = (trialStore?.records ?? []).some((row) =>
        row.dispatchKind === 'session-delegation' && row.pr === Number(pr));
      if (delegation && !alreadyLogged && !isDelegationTripleGraduated(delegation, trialStore)) {
        const logged = logTrialFn({
          provider: delegation.provider,
          model: delegation.model,
          taskType: delegation.taskType,
          taskDescription: prTitle || `PR #${pr}`,
          outcome: 'landed',
          verifiedBy: 'independent-claude',
          findings: null,
          pr: Number(pr),
        }, trialLogIo);
        if (logged === null) throw new Error('could not write trial to the scorecard store');
        const publishResult = publishTrialFn({ ...delegation, pr: Number(pr) });
        if (!publishResult.committed || !publishResult.pushed) {
          const location = publishResult.committed ? 'a local commit' : "this checkout's working tree";
          process.stderr.write(`review-set-label: delegation trial row WRITTEN LOCALLY BUT NOT ON SHARED HISTORY (#3690, non-fatal) — ${publishResult.reason} — the row is only in ${location}; commit+push scripts/conveyor/run-scorecards.json by hand (push the existing commit if already committed) or it may be lost.\n`);
        }
      }
    } catch (e) {
      process.stderr.write(`review-set-label: delegation trial append failed (#3690, non-fatal) — ${String((e && e.message) || e).split('\n')[0]}\n`);
    }
  }

  // we:scripts/review-set-label.mjs#runReviewLabelCli — re-read the labels so the printed result reflects the
  // true post-swap state (tolerant: fall back to a locally-derived set if the re-read fails).
  let newLabels;
  try {
    newLabels = provider.readLabels(repo, pr).map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean);
  } catch {
    const names = (Array.isArray(currentLabels) ? currentLabels : [])
      .map((l) => (typeof l === 'string' ? l : l && l.name)).filter(Boolean)
      .filter((n) => !removals.includes(n));
    newLabels = [...new Set([...names, decision.addLabel])];
  }

  emit(`${JSON.stringify(successResult({ pr: Number(pr), to, decision, labels: newLabels }))}\n`);
  process.exit(0);
}

/**
 * we:scripts/review-set-label.mjs#buildVerdictComment — the reviewer-verdict comment body. PURE, so the one
 * place the `reviewed-sha` marker is attached to an accept is unit-testable.
 *
 * #2882 — `body` is the OPTIONAL caller-supplied write-up. The loop console records a one-line verdict and
 * passes nothing; `/review` (`we:skills-src/review/SKILL.md`) passes its full findings + verdict via
 * `--body-file`. Before this, the CLI could only emit the fixed one-liner, so `/review` hand-rolled
 * `gh pr edit` + `gh pr comment` to get a detailed comment — and thereby lost the marker AND bypassed
 * INVARIANT 2, which lives in `decideSetLabel` and only binds callers that come through here. Accepting a body
 * removes the reason to route around the single home.
 *
 * #2409 — on `accepted` the reviewed head SHA is stamped (`buildReviewedShaMarker`) so the drain can later
 * refuse to honour the acceptance if the head advanced past the reviewed tree.
 *
 * THE STAMP MUST WIN, AND THE READER DECIDES WHAT WINNING MEANS. `parseReviewedSha` is LAST-match-wins (it
 * scans every marker in a body and keeps the final one), so this builder does two things, belt and braces:
 *   1. it STRIPS any `reviewed-sha` marker out of the caller's body — a `/review` write-up legitimately quotes
 *      a prior round's marker while explaining why the head moved (#983's re-accept comment did exactly that),
 *      and a quoted marker must never be mistaken for this verdict's claim; and
 *   2. it appends its own marker LAST, so even a marker this strip failed to recognise cannot outrank it.
 * The first cut of #2882 put the marker FIRST and reasoned backwards about the reader — which silently
 * REGRESSED the pre-#2882 behaviour, because a quoted marker then overwrote the stamp. Caught in review on
 * PR #1005. The pin for this is a ROUND-TRIP assertion through the real `parseReviewedSha`, never a
 * string-position one: verifying producer and consumer independently is exactly how the inversion hid.
 *
 * The marker is omitted on `changes`, and when the head SHA is unavailable (`buildReviewedShaMarker` → '') the
 * gate fails open rather than reading a garbage marker.
 * #2844 — an acceptance also stamps WHO cleared it (`cleared-by-actor`, the harness session id — NOT the
 * free-text `--actor`, which is the point) and, when independence could NOT be established, says so in the
 * attribution. A clearance record that names only a self-declared actor is the "asserted but unenforced" state
 * this item exists to end; naming the id makes a later self-clear audit a machine read, not an archaeology.
 *
 * #2898 — THE CHANNEL IS AN INPUT, NOT A CONSTANT. This sentence used to end "via the Plateau Loop review
 * console" unconditionally, written when the module had exactly one caller. It now has four (the console, the
 * conveyor re-arm, `/review`, and since #3035 the declared `review-pr` operation), so the constant asserted a
 * provenance three of them did not come through. It was observed live on PR #1146: the operation's own footer
 * said *"Recorded through the declared `review-pr` operation (#3035)"* while this line, higher in the SAME
 * comment, credited the console. A durable record that states two provenances is worse than one that states
 * none — so a caller that supplies no `channel` now gets the NEUTRAL sentence (`Recorded by <actor>.`), never
 * another caller's identity. The caller knows the surface; it is told, and this renders what it is given.
 *
 * @param {{to:string, actor:string, headSha?:string, body?:string, reason?:string, reviewedDiff?:string,
 *   clearerId?:string, independence?:{independent:boolean,status:string,reason:string}|null,
 *   channel?:string, humanClearance?:{actor:string,sha:string}|null}} o -
 *   #x169fqe: `reviewedDiff` is the raw diff (or a precomputed fingerprint) the verdict was formed against.
 *   Omitted → no diff marker → the gate falls back to SHA identity, i.e. pre-#x169fqe behaviour.
 *   #2898: `channel` is the SURFACE the verdict came through, free text like `actor` (see `normalizeChannel`).
 *   #x9krtkb: `humanClearance` is ONLY meaningful on `to==='restamp'` — the caller's own proof (see
 *   `runReviewLabelCli`) that the acceptance being carried across this rebase was a `clear-human` ceremony AND
 *   that the reviewed content is unchanged at the new head. `null`/omitted renders a PLAIN restamp, exactly as
 *   before this field existed — a restamp of a plain agent accept must never mint a human clearance.
 * @returns {string}
 */
export function buildVerdictComment({
  to, actor, headSha = '', body = '', reason = '', reviewedDiff = '', clearerId = '', independence = null,
  channel = '', humanClearance = null,
} = {}) {
  // #2895 — `clear-human` stamps the marker for the same reason `accepted` does: it IS an acceptance (it adds
  // review:accepted), so the drain must be able to refuse it later if the head advances past the cleared tree.
  // #x169fqe — the reviewed DIFF is stamped alongside the reviewed SHA, so a later content-preserving rebase
  // (the drain's own manifest-drop pass) can be recognised as covered instead of invalidating this accept.
  // `buildReviewedDiffMarker` returns '' when no diff was supplied, in which case the record carries only the
  // SHA and the gate behaves exactly as it did before this change.
  // #x9xqexm — the CONTRIBUTION fingerprint is stamped from the SAME `reviewedDiff` text (no extra git call), so
  // the drain can tell "the base moved under this lane" from "new content arrived". Without it the `reviewed-diff`
  // digest changes every time `main` shifts a context line or a hunk offset, which the drain's own rebase-drop
  // pass causes within minutes of every accept — measured on PR #1100, where the clearance was revoked 3m07s
  // after it was granted over three lines of pure base movement.
  const stampsAcceptance = to === 'accepted' || to === 'clear-human' || to === 'restamp';
  // #x9krtkb — is THIS restamp carrying a human clearance forward? Only ever true on `to==='restamp'`, and only
  // when the caller (`runReviewLabelCli`) already proved both halves — see the param doc above. Named once so
  // the marker block and the attribution/heading text below can't drift on what "carrying" means.
  const carriesHumanClearance = to === 'restamp' && !!humanClearance;
  // #xmnl36p — `clear-human` ALSO stamps a machine-readable clearance marker, so an automated re-score can read
  // the clearance back and announce that it is overriding one (`parseOperatorClearance`). Until this, the only
  // record was the prose attribution below — which the reader still parses as a fallback, so clearances written
  // before this item (WE PR #1106 among them) are covered too. The marker adds NO authority: nothing merges on
  // it; it exists so a re-hold can be loud instead of silent.
  // #x9krtkb — `restamp` stamps the SAME marker, with the ORIGINAL clearer's name, when `carriesHumanClearance`
  // — this is what makes `parseLatestHumanClearedSha` (which binds `reviewed-sha` and `cleared-human` to the
  // SAME comment) see THIS comment as human-covered too, so the carry survives a SECOND rebase off THIS
  // restamp rather than only the first one off the original clear-human.
  const marker = stampsAcceptance
    ? [
      buildReviewedShaMarker(headSha),
      buildReviewedDiffMarker(reviewedDiff),
      buildReviewedContributionMarker(reviewedDiff),
      to === 'clear-human' ? buildClearedHumanMarker(actor)
        : carriesHumanClearance ? buildClearedHumanMarker(humanClearance.actor) : '',
      buildClearerActorMarker(clearerId),
    ].filter(Boolean).join('\n')
    : '';
  // #2844 — the independence line. Printed ONLY when the bar was not met, so a clean record stays terse.
  // Silence would be the failure mode: a reader must not infer independence from its absence.
  //
  // TWO SHAPES, because two different things happened (PR #1100 review). A `clear-human` self-clear is the
  // EXEMPTION — the human ceremony ran on a PR opened by the same session, which is the operator's ordinary
  // workflow (a subagent inherits its parent's session id), and the record must say THAT rather than filing it
  // under the same ⚠️ as an accept whose independence merely could not be checked. Everything else that failed
  // the bar keeps the ⚠️ wording. On `--to=accepted` a proven self-clear never reaches here at all — the CLI
  // refuses it before any write — so that combination only ever renders in the size projection.
  const humanCeremonyExemption = to === 'clear-human' && independence
    && independence.status === INDEPENDENCE.SELF_CLEAR;
  const independenceNote = !(stampsAcceptance && independence && independence.independent === false)
    ? ''
    : humanCeremonyExemption
      ? '\n\n🧑 Cleared by the HUMAN CEREMONY, not by an established-independent agent (#2844). The clearing '
        + `actor is this PR's own author (${clearerId}) — a subagent inherits its parent's session id, so the `
        + 'operator clearing a PR their own session opened reads as a self-clear at the session level. '
        + '`--to=clear-human` is EXEMPT from the self-clear refusal that binds `--to=accepted`, because it '
        + 'carries a stronger signal than a session id: it is refused unless the PR carries `review:human`, and '
        + 'it requires the explicit actor and the quoted reason above. Read this as "a human ceremony cleared '
        + 'it", NOT as "an independent reviewer cleared it".'
      : `\n\n⚠️ Independence NOT established for this clearance (#2844): ${independence.reason}. `
        + 'This record does not show that a party other than the author cleared it.';
  const text = String(typeof body === 'string' ? body : '').trim();
  const heading = to === 'clear-human'
    ? '✅ review — `review:human` cleared via the sanctioned path'
    // #x5e2ldj — `restamp` gets its OWN heading. It is not an accept (no review was run) and emphatically not a
    // bounce; rendering it as either would make the durable comment say something that did not happen. The
    // review of PR #1482 caught this exact defect: the ternary fell through to the BOUNCE heading, so a
    // re-stamped ACCEPTANCE would have announced itself as "changes requested".
    : to === 'restamp' ? '📌 review — acceptance re-stamped after a rebase (no new review)'
      : to === 'accepted' ? '✅ review — accepted' : '🔁 review — changes requested';
  // #2895 — the attribution is the point of the whole item: a raw `gh` call recorded none of this. On the
  // gate-self path it must state EXACTLY what the record proves and no more. It proves the sanctioned path was
  // followed; it does NOT prove a human followed it, because `--actor` and `--reason` are free text and nothing
  // here verifies either. Saying so in the durable record is the honesty tax, and it is not optional: a reader
  // who trusts this further than it earns is the failure mode the deferral of the actor signal creates.
  // #x9krtkb — the CARRIED-CLEARANCE sentence. It must say, in plain words, that (a) a human cleared this PR
  // before, (b) THIS record did not run a review of its own, and (c) the clearance still stands because the
  // drain's own rebase preserved the content — naming the original clearer so a reader never has to go dig for
  // which comment actually granted it. This is the sentence #2572 lacked, which is what let the anti-test-
  // gaming gate see "latest accept-shaped comment has no cleared-human marker" and re-park review:human on a
  // PR a human had just cleared minutes earlier.
  const carriedClearanceNote = carriesHumanClearance
    ? ` The HUMAN clearance ${humanClearance.actor} granted (reviewed-sha ${String(humanClearance.sha).slice(0, 12)}…) `
      + 'is carried forward to this head: the drain\'s own content-preserving rebase moved the tree, and the '
      + 'reviewed diff/contribution is unchanged, so that clearance still covers it (#x9krtkb). No new review '
      + 'ran here — `review:human` stays cleared on the strength of the ORIGINAL clearance, not a fresh one.'
    : '';
  const attribution = to === 'clear-human'
    ? `Cleared by ${actor} via \`review-set-label.mjs --to=clear-human\` (#2895).\n\n`
      + `> ${String(reason || '').split('\n').join('\n> ')}\n\n`
      + 'What this record proves: the clearance went through the sanctioned tool, so the label swap, the '
      + '`reviewed-sha` stamp and this comment exist and agree. What it does NOT prove: that a human performed '
      + 'it. The actor name and the reason above are free text and nothing verifies who supplied them — #2895 '
      + 'deferred the unforgeable actor signal (no local construct survives an agent with shell access on the '
      + 'same machine), and #2946 is the durable fix.'
    : `Recorded by ${actor}${normalizeChannel(channel) ? ` via ${normalizeChannel(channel)}` : ''}.${carriedClearanceNote}`;
  // ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // THE RENDER BOUNDARY (PR #1147 review — the structural close of the marker-forgery class).
  //
  // Everything ABOVE this line is PROSE and may carry caller free text — `actor`, `body`, `reason`, `channel`,
  // and whatever field the next caller needs. Everything BELOW it is the TRUSTED marker block, built only by
  // the validating `build*Marker` helpers. One sanitizer sits on the seam, so the guarantee is a property of
  // the SHAPE of this function rather than of a list of field names that has to be kept in sync.
  //
  // WHY NOT PER-FIELD. #2898 sanitized `--channel` and left `--actor` — its sibling, rendered by the very next
  // interpolation on the same line — reachable, and PR #1147's reviewer proved it: `--actor` alone forged a
  // `reviewed-sha` that `parseReviewedSha` read as gospel on a `changes` verdict (which appends no marker of
  // its own, so the forgery is the ONLY one in the body and last-match-wins hands it the win). Patching the
  // second field would have left the third. The per-input pattern re-opens on every new input by construction;
  // this does not.
  //
  // WHY SHAPE, NOT NAMES. The sanitizer neutralizes the HTML-comment SYNTAX, not a list of marker names. Every
  // MARKER this repo reads — `reviewed-sha`, `reviewed-diff`, `reviewed-contribution` (all three in
  // `we:scripts/lib/review-escalation.mjs`), the `cleared-human` MARKER (ditto), `cleared-by-actor` /
  // `authored-by-actor` (`we:scripts/lib/review-independence.mjs`), `drain-{park,skip,land}-reason`
  // (`we:scripts/merge-ai-prs.mjs`) — needs a literal `<!--` to open. Those parsers each hard-code their own
  // regex, so there is NO single list to derive a strip-set from; matching on the syntax is the only close that
  // covers a marker defined in a module this one does not import, or one invented after today.
  //
  // THE ONE PARSER THIS DOES NOT COVER, NAMED RATHER THAN LEFT IMPLICIT (#3060). `parseOperatorClearance`'s
  // OTHER regex, `CLEARED_HUMAN_PROSE_RE` in `we:scripts/lib/review-escalation.mjs`, is not marker-shaped — it
  // opens on the plain words "Cleared by … via `review-set-label.mjs --to=clear-human`", with no `<!--`
  // anywhere, so escaping HTML-comment delimiters gives it no purchase at all. A `body`/`reason` field shaped
  // like that sentence sailed straight through this boundary and parsed as a real clearance. It is closed
  // separately, by anchoring THAT regex to the start of the rendered body under the known `clear-human`
  // heading (a shape only this function's own preamble can produce, never a caller field, which is always
  // appended later) — see the note on `CLEARED_HUMAN_PROSE_RE` for the reasoning. Said again so it is not
  // missed: this render boundary is a complete answer for every `<!--`-opening marker, and an incomplete one for
  // prose-shaped parsers, which need their own per-parser argument.
  //
  // WHY ESCAPE RATHER THAN DELETE. `&lt;!--` renders as a visible `<!--` on GitHub, so a `/review` write-up
  // that legitimately QUOTES a prior round's marker still reads correctly (#983's re-accept comment did exactly
  // that) — it is simply inert to every parser, all of which scan the RAW body `gh pr view --json comments`
  // returns. Over-neutralizing is the safe direction: an escaped marker is text, an un-escaped one outranks the
  // real stamp.
  const prose = neutralizeCommentMarkers([
    heading,
    '',
    attribution + independenceNote,
    ...(text ? ['', text] : []),
  ].join('\n'));
  return marker ? `${prose}\n\n${marker}` : prose;
}

/**
 * we:scripts/review-set-label.mjs#normalizeChannel — the `--channel` value as ONE clause of ONE sentence. PURE.
 *
 * It is argv free text that lands mid-sentence in a durable public comment, so two things are done to it and
 * each has a reason:
 *   1. WHITESPACE COLLAPSED to single spaces. A newline would break the attribution paragraph in two and let
 *      the second half read as the comment's own prose.
 *   2. TRAILING PUNCTUATION TRIMMED, so `--channel="the console."` does not render "console..".
 * The empty string means "no channel stated", which renders the neutral sentence.
 *
 * IT NO LONGER STRIPS MARKERS, and that is the point (PR #1147 review). #2898 put a `reviewed-sha` strip here,
 * which made this function a SECOND home for a guarantee — and the first home never covered `--actor`, so the
 * hole stayed open in the field rendered by the same sentence. Marker neutralization now happens once, at
 * `buildVerdictComment`'s render boundary, where it covers every prose field including the ones added next.
 * Presentation lives here; safety lives there.
 */
export function normalizeChannel(channel) {
  return String(channel ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/, '');
}

/** GitHub's hard cap on an issue/PR comment body. Checked BEFORE the label swap, on the rendered bytes in
 *  `runReviewLabelCli` (unskippable) and again from argv in the CLI block below (names the flag to trim). */
export const GH_COMMENT_MAX = 65536;

/** Who the durable comment is attributed to when `--actor` is absent. `clear-human` REFUSES this default. */
export const DEFAULT_ACTOR = 'loop-console operator';

/**
 * we:scripts/review-set-label.mjs#neutralizeCommentMarkers — make every HTML comment in a stretch of text INERT
 * to every `<!--`-OPENING marker parser in the constellation, while keeping it readable. PURE. The sanitizer
 * that sits on `buildVerdictComment`'s render boundary; see the long note there for why the boundary, and not
 * the inputs, is where this belongs.
 *
 * WHAT IT DOES: escapes the DELIMITERS — `<!--` → `&lt;!--`, `-->` → `--&gt;`. Nothing else is touched.
 *
 * WHY THAT IS SUFFICIENT for a marker parser, and how to falsify it. Every MARKER read anywhere in this repo is
 * matched by a regex that opens on a literal `<!--` (`REVIEWED_SHA_RE`, `REVIEWED_DIFF_RE`,
 * `REVIEWED_CONTRIBUTION_RE`, `CLEARED_HUMAN_RE` in `we:scripts/lib/review-escalation.mjs`; `actorMarkerRe` in
 * `we:scripts/lib/review-independence.mjs`; `drainReasonMarker` in `we:scripts/merge-ai-prs.mjs`). Remove every
 * literal `<!--` from a string and NONE of them can match it, whatever the marker is named, however the payload
 * is cased or spaced, and whether or not the marker was invented after this line was written. That is a
 * property of the marker SYNTAX, so it holds for markers this module cannot even see — which matters, because
 * those parsers each hard-code their own pattern and there is no shared registry to derive a strip-list from.
 *
 * WHAT IT IS NOT SUFFICIENT FOR (#3060, found FALSE against the code, not assumed true). Not every clearance
 * READER in this repo is marker-shaped: `parseOperatorClearance`'s prose fallback, `CLEARED_HUMAN_PROSE_RE`,
 * opens on the plain sentence "Cleared by … via `review-set-label.mjs --to=clear-human`" and contains no `<!--`
 * at all, so this escape gives it no purchase — a caller-supplied field shaped like that sentence sailed
 * straight through and parsed as a real clearance (`buildVerdictComment({to:'changes', body: thatSentence})`
 * against pre-#3060 code). It is closed at its own definition instead, by anchoring the regex to the exact
 * `clear-human` render shape rather than by widening what this function escapes — see the note beside
 * `CLEARED_HUMAN_PROSE_RE` in `we:scripts/lib/review-escalation.mjs`. Read "every marker" above as scoped to
 * marker-shaped parsers; it was never, and is not now, a claim about every parser this repo runs over a comment
 * body.
 *
 * WHY IT IS NOT A DELETE. `&lt;!--` renders as a literal `<!--` in GitHub-flavoured markdown, so a quoted
 * marker still SAYS what the write-up meant it to say; the parsers read the raw body, where it is inert. The
 * predecessor (`stripReviewedShaMarkers`) replaced one named marker with a backticked placeholder; this keeps
 * that readability property while covering every marker instead of one.
 *
 * ORDERING NOTE: `<!--` is escaped first, so the `--` it leaves behind cannot be re-consumed by the `-->` pass
 * (`&lt;!--` ends in `--`, and the closer pass needs `-->`).
 */
export function neutralizeCommentMarkers(text) {
  return String(text ?? '')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .trim();
}

/**
 * we:scripts/review-set-label.mjs#projectVerdictCommentLength — the WORST-CASE rendered length of the durable
 * comment, taken over EVERY member of `REVIEW_LABEL_TARGETS` with the ACTUAL caller-supplied variable-length
 * inputs (body, actor, reason) and a full-length SHA. PURE.
 *
 * Total over the target set, and over every unbounded input, on purpose (PR #1056 review, M2). The first cut
 * projected `to: 'accepted'` only, while `clear-human` renders a longer heading plus its attribution — a body in
 * the 65,405–65,536 band therefore PASSED the pre-flight and `gh pr comment` then failed on GitHub's cap. Under
 * the swap-first order of the day that left an ACCEPTED PR with no `reviewed-sha` marker; `acceptanceCoversHead`
 * fails OPEN on a missing marker, so it silently disarmed the staleness gate — exactly the partial state the
 * pre-flight exists to prevent. #2964 moved the comment ahead of the swap on a PR that is not already accepted,
 * so an under-count there now costs a failed run rather than a disarmed gate; on an ALREADY-accepted PR the swap
 * still goes first and the original consequence stands unchanged. `actor` and `reason` are argv and therefore
 * unbounded too, so they are projected from what
 * was actually passed rather than from a fixed-width placeholder that a long one would overrun. Over-estimating
 * is the safe direction: the cost is asking the operator to trim a body that would just barely have fitted.
 * #2844 — the projection is ALSO total over the independence outcomes, for the same reason it is total over the
 * targets: the `⚠️ Independence NOT established` note is extra chrome the earlier projection would have missed,
 * and under-counting it is precisely the 65,405–65,536 band failure M2 documents. Both unproven statuses render
 * a FIXED-length message (the proven `self-clear` never renders — the CLI refuses it before any write), so the
 * worst case is computed here from the real decider rather than guessed at with a placeholder width.
 * #2898 — `channel` joins them for the SAME reason: it is argv free text that lands in the rendered comment, so
 * leaving it out of the projection re-opens the exact gap `--reason` had (PR #1057).
 * @param {{body?:string, actor?:string, reason?:string, clearerId?:string, channel?:string}} o - the
 *   caller-supplied variable-length inputs
 * @returns {number} the largest length any target renders to
 */
export function projectVerdictCommentLength({ body = '', actor = '', reason = '', clearerId = '', channel = '' } = {}) {
  // #x9xqexm — project the DIFF + CONTRIBUTION markers at full width too. A 64-hex string is the idempotence
  // shortcut in both `normalize*Fingerprint`s, so this renders exactly the bytes a real accept stamps; before,
  // the projection passed no diff, both markers rendered as '', and the estimate was ~180 chars short of what
  // the accept path actually posts — the same under-count class as the `to: 'accepted'`-only bug (#1056 M2).
  // #2844 — the not-established outcomes, worst case. `unknown-clearer` fires on an empty clearer id;
  // `unknown-author` on a present clearer with no author stamp; `self-clear` on two equal ids — which
  // `--to=clear-human` now RENDERS (the PR #1100 human-ceremony exemption: it is no longer refused, so its note
  // reaches the comment and must be counted, exactly the under-count M2 documents). All three messages embed the
  // clearer id, so each is projected with the REAL one rather than a fixed-width stand-in.
  const outcomes = [
    null,
    decideClearerIndependence({ authorId: '', clearerId: '' }),
    decideClearerIndependence({ authorId: '', clearerId: clearerId || 'x' }),
    decideClearerIndependence({ authorId: clearerId || 'x', clearerId: clearerId || 'x' }),
  ];
  // #x9krtkb — `restamp` can ALSO render the carried-clearance sentence, extra chrome the pre-#x9krtkb
  // projection never rendered at all. The ORIGINAL clearer's name is not knowable here — this pre-flight runs
  // before the PR's comments are ever fetched — so it is approximated with the SAME `actor` this call was
  // already given (the caller-supplied width closest in kind: free-text attribution). This is a HEURISTIC, not
  // a proof — unlike every other branch of this projection, which is exact — but it is strictly better than the
  // blind spot it replaces, and the RENDERED-BYTES guard in `runReviewLabelCli` (checked against the REAL
  // `humanClearance`, before any write) is what actually enforces the cap; this projection is belt-and-braces.
  const humanClearances = [null, { actor: actor || 'x', sha: 'f'.repeat(40) }];
  return Math.max(...REVIEW_LABEL_TARGETS.flatMap((to) => outcomes.flatMap((independence) => humanClearances.map(
    (humanClearance) => buildVerdictComment({
      to, actor, headSha: 'f'.repeat(40), body, reason, reviewedDiff: 'f'.repeat(64), clearerId, independence,
      channel, humanClearance,
    }).length,
  ))));
}

// we:scripts/review-set-label.mjs — allow importing the pure decider + shared harness without running the CLI
// (the test file and rearm-review.mjs import this module). The standard main check used in review-detail.mjs.
const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  // #2882 — the OPTIONAL `--body-file=<path>` carries the caller's write-up (see `buildVerdictComment`). Every
  // check happens HERE, before any gh mutation, because this flag used to fail in the worst direction: the label
  // was applied first and the comment posted second, so a body problem discovered late left an ACCEPTED PR with
  // no marker — and `acceptanceCoversHead` fails open on a missing marker, so the drain then landed it. #2964
  // reordered the writes and that path is closed for a first accept, but it is NOT closed on an already-accepted
  // PR (which still swaps first, deliberately — see `runReviewLabelCli`), and even where it is closed a late body
  // failure still costs an orphan record and a re-run. Checking before any write is cheaper than either.
  // PR #1005 review, minors 2-4.
  const argvRest = process.argv.slice(2);
  // The bare `--body-file <path>` form is REJECTED, not silently ignored: ignoring it posts a verdict with the
  // findings missing and still exits 0. Every other flag in the harness is `=`-form; say so rather than no-op.
  const bareIdx = argvRest.indexOf('--body-file');
  if (bareIdx !== -1) fail('use --body-file=<path> (the =-form) — the space-separated form is not accepted');
  const bodyFileArg = (argvRest.find((a) => a.startsWith('--body-file=')) || '').slice('--body-file='.length);
  // The other two variable-length inputs the durable comment renders. Read here ONLY so the size pre-flight
  // below can be a real upper bound (#1056 M2) — `runReviewLabelCli` re-parses them and owns their validation.
  const projActor = (argvRest.find((a) => a.startsWith('--actor=')) || '').slice('--actor='.length) || DEFAULT_ACTOR;
  const projReason = (argvRest.find((a) => a.startsWith('--reason=')) || '').slice('--reason='.length);
  // #2898 — the SURFACE this verdict came through. Free text and therefore unbounded, exactly like `--actor`
  // and `--reason`, so it is read here for the same reason they are: the size pre-flight below must be a real
  // upper bound over EVERY variable-length input, which is the PR #1057 lesson (`--reason` was added later and
  // went unprojected). Absent → the neutral attribution; never another caller's channel.
  const verdictChannel = (argvRest.find((a) => a.startsWith('--channel=')) || '').slice('--channel='.length);
  let verdictBody = '';
  if (bodyFileArg) {
    // Constrain the path: this file's contents are published to a PUBLIC PR and cannot be unpublished. A stale
    // shell variable or a wrong path would otherwise leak whatever it points at, with the CLI reporting
    // success. See {@link checkBodyFileLocation} for which roots and why the refusal now NAMES them.
    const abs = resolve(bodyFileArg);
    const located = checkBodyFileLocation(abs, bodyFileRoots());
    if (!located.ok) {
      fail(`--body-file must live under the repo root or a temp dir (got ${abs}) — its contents are published `
        + `to a public PR, so the path is constrained. Allowed roots: ${located.roots.join(', ')}`);
    }
    try { verdictBody = readFileSync(abs, 'utf8'); }
    catch (e) { fail(`--body-file=${bodyFileArg} is unreadable (${String((e && e.message) || e).split('\n')[0]})`); }
    if (!verdictBody.trim()) fail(`--body-file=${bodyFileArg} is empty — pass the verdict write-up, or omit the flag for the one-line record`);
  }
  // GitHub rejects a comment body over 65536 chars, and it rejects it AFTER the swap has landed. The authoritative
  // guard is on the RENDERED bytes in `runReviewLabelCli`; this argv projection is belt-and-braces, kept because it
  // fires before ANY gh call and can name the flag to trim. UNCONDITIONAL — PR #1057 review: it used to sit inside
  // the `if (bodyFileArg)` branch above, so `--reason`, added later and just as unbounded, was unguarded whenever
  // no `--body-file` was passed. Projected over the WHOLE target set AND every free-text argv input; see
  // `projectVerdictCommentLength`.
  const projected = projectVerdictCommentLength({
    body: verdictBody, actor: projActor, reason: projReason, clearerId: currentActorId(), channel: verdictChannel,
  });
  if (projected > GH_COMMENT_MAX) {
    const flag = [[verdictBody.length, `--body-file=${bodyFileArg}`], [projReason.length, '--reason'],
      [projActor.length, '--actor'], [verdictChannel.length, '--channel']].sort((a, b) => b[0] - a[0])[0][1];
    fail(`${flag} renders a ${projected}-char comment, over GitHub's ${GH_COMMENT_MAX} limit — trim it (nothing was changed: no comment, no label)`);
  }
  runReviewLabelCli({
    defaultActor: DEFAULT_ACTOR,
    // Handed over so the harness can refuse an empty `--to=changes` alongside its other pre-flight checks
    // (#xd6moh1). The rendered body still comes from the `buildComment` closure below — same text, one read.
    verdictBody,
    usage: 'usage: review-set-label.mjs <pr> --repo=<owner/name> --to=accepted|changes|clear-human [--actor=<name>] [--channel=<surface>] [--body-file=<path>]  (pr must be a positive integer; changes REQUIRES --body-file=<the findings>; clear-human additionally requires --actor and --reason=<stated reason>)',
    buildComment: ({ to, actor, headSha, reason, reviewedDiff, clearerId, independence, humanClearance }) => buildVerdictComment({
      to, actor, headSha, reason, reviewedDiff, clearerId, independence, body: verdictBody, channel: verdictChannel,
      humanClearance,
    }),
    successResult: ({ pr, to, labels }) => ({ ok: true, pr, to, labels }),
    refusalResult: ({ decision }) => ({ error: decision.reason }),
    // #2895 — UNCONDITIONAL, so every shell invocation of this CLI is opted in, including one run for
    // `--to=accepted`. The opt-in therefore constrains nothing here; it exists so an IMPORTER of
    // `runReviewLabelCli` has to name the capability in its own source. See `allowClearHuman` on that function
    // for exactly how far that goes (not far — it is not a barrier).
    allowClearHuman: true,
  });
}

/** we:scripts/review-set-label.mjs#fail — print a machine-readable error and exit non-zero. */
function fail(message, code = 2) {
  writeAllSync(1, `${JSON.stringify({ error: message })}\n`);
  process.exit(code);
}

/** we:scripts/review-set-label.mjs#ghErr — the last non-empty line of a `gh` failure (stderr wins). */
function ghErr(e, fallback) {
  return String((e && (e.stderr || e.message)) || e).split('\n').filter(Boolean).pop() || fallback;
}
