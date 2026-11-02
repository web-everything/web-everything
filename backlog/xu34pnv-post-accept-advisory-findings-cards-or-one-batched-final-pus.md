---
kind: decision
size: 3
parent: "5467"
status: open
scaffoldedBy: "post-accept-advisory"
dateScaffolded: "2026-11-01"
dateOpened: "2026-11-01"
tags: [review]
relatedTo: ["5471", "5472", "x5vjl3o"]
---


# Post-accept advisory findings: cards or one batched final push, instead of re-arming review

Operator ruling R368 (2026-11-01). Finding from R365 fix #4 (PR #6201): review churn comes from fixer and advisory-fix pushes made AFTER an accept. On PRs #6158, #6033 and #6141 every loop ran on a new git tree, because each post-accept push re-arms a full review. Those 3 PRs used 29% of all review loops, at 5 to 13 loops each. Policy only here; the mechanics are in the build child x5vjl3o.

Grounding: the round budget (5471) already turns `cosmetic`/`degraded` findings into cards past round K (`CARDABLE_IMPACTS`, we:scripts/lib/review-loop-policy.mjs:586; the decision at :604-611). It stops at the accept. Nothing governs a finding raised with or after the accept; the advisory fixer (we:scripts/conveyor/advisory-fix-mark.mjs) still pushes for it. Heal commits are handled by 5472 `healDeltaReview` (ratified, off by default), which keys on heal-role commits only.

## Known occurrences

PRs #6158, #6033, #6141 (R365 fix #4 data, 5 to 13 loops each, 29% of all loops, every loop on a new tree). Earlier same shape: PRs 4484 and 4453 lost a full round after accept to a heal (card 5472).

## Fork 1 — What happens to advisory or degraded findings raised with or after an accept

Fork-existence: a finding either gets a push or it does not; the flawed branch is (c), which makes every advisory finding cost a full re-review of a tree that was already accepted. (a) and (b) cannot both apply to one finding. "Raised with the accept" means findings held on the accepted verdict plus findings any review seat records against the same accepted head.

- (a) **Cards, no push (default).** The PR merges as accepted. The card is filed FIRST (one card per PR, one numbered line per finding, the 5471 shape), and the PR merges only once it exists. No new head, so no new review. Applies only when the 5471 refusal guards (`roundCardsRefusal` in we:scripts/lib/review-loop-policy.mjs: human-required, a pending or blocked referral, an uncorroborated retirement) are all clear; any guard that fires forces a push. The round number K is irrelevant here: this acts at the accept at any round, where 5471 acts on a bounce past round K.
- (b) One batched final push of all advisory fixes, reviewed for the delta only. It puts new, unreviewed code on a tree already accepted, and the fix can raise findings of its own, so one more loop per PR remains and the accepted tree is changed. That is a risk difference, not only a cost one.
- (c) Unchanged: each advisory finding is fixed by a push and re-reviewed in full. (This is the `off` value of the setting.)

**Default: (a).** The accept already says the tree is good enough to merge; an advisory finding costs a follow-up, not a block. Statute: `#claim-accuracy-advisory-blocks-on-impact` (advisory findings block on impact, so cosmetic/degraded ones do not block) and `#agent-convergence-independent-validation` (an accept is an independent validation) both agree and are the cited authority.

Skeptic: SURVIVES-WITH-AMENDMENT. Folded in: applies only when the 5471 refusal guards are clear; K stated irrelevant; "raised with the accept" defined; both statute anchors cited; card filed before merge.
Screen: clear (rescreen, fresh agent): rules on merge and review policy, invisible to consumers; (b) puts unreviewed code on an accepted tree, a real merit difference.

## Fork 2 — Which findings still force a push after an accept

Fork-existence: the flawed branch is "nothing forces a push", which would merge a confirmed bug; "everything forces a push" is Fork 1 (c). The line sits between, so where to draw it is a real either/or.

- (a) **A finding forces a push when its impact is not in `CARDABLE_IMPACTS` (so `broken`, `unrecoverable`, or unstated), or `requiresMandatoryReferral` is true, or it is a security finding, or any `roundCardsRefusal` guard fires (default).** The rule calls the 5471 function and does not restate it. "Security finding" is the one addition to the 5471 split: the review seat's security lens tags it, and it forces a push at any impact.
- (b) Only confirmed broken correctness or security; unstated impact is carded. Fewer pushes, but a missing label then silently downgrades a finding.
- (c) A wider list that also pushes `degraded` findings on a trust boundary (auth, secrets, writes outside the repo). Safer, but a second list to maintain; rejected as a config extension of (a), not a separate branch.

**Default: (a).** Fail closed on doubt. A CI failure or a drain re-check failure is not a review finding and still blocks as today.

Skeptic: SURVIVES-WITH-AMENDMENT. Folded in: the rule reuses the 5471 function and `requiresMandatoryReferral` rather than restating them; "exactly the 5471 split" claim removed; security tag named as the one addition; guard failures force a push.
Screen: flagged(prio) (rescreen, fresh agent) -> merge (b) and (c) into (a) as config variants and state the merit as fail-closed vs fail-open on unstated impact. Not applied: the one fix-and-rescreen allowed was spent; for the operator to rule or send back.

## Fork 3 — End rule and evidence bar

Fork-existence: the flawed branches are "ship on with no evidence" and "shadow forever": the first changes what merges without measurement, the second never removes the churn. The bar has to be named.

- (a) **Steady state is `on`; `off` is the kill switch; the setting is `review.postAcceptAdvisory.mode` (off | shadow | on) through the policy cascade (default).** Promotion from `shadow` to `on` needs at least 20 shadow PRs that EACH carried at least one would-have-carded finding, with a named detector: in shadow the fixer still pushes, so the fixer's diff journals whether each would-have-carded finding was a real defect (fixer-confirmed, or re-rated by a later review). One `broken` re-rate counts against promotion. After promotion, the mode drops back to `shadow` on a post-merge defect traced to a carded finding (detector: a carded finding re-rated `broken`, or a revert of the merge), or if open carded lines from this rule exceed a count set in the build child.
- (b) Ship `on` directly with only the replay of the three PRs as evidence.
- (c) Shadow only, report only.

**Default: (a).** Staging and the cascade wiring live in the build child x5vjl3o; only the bar and the end rule are decided here. Same pattern as 5469 and the 5471 `roundBudget`.

Skeptic: SURVIVES-WITH-AMENDMENT. Folded in: the promotion bar now counts only PRs that had would-have-carded findings, names a detector (fixer diff journal or re-rate), and adds a revert detector and a card-debt trigger to the end rule.
Screen: flagged(prio) (rescreen, fresh agent) -> reduce to the evidence bar and end rule as one ratified default; thresholds (20 PRs, 14 days, card-debt count) are tuning, and off|shadow|on staging is rollout order. Not applied: the one fix-and-rescreen allowed was spent; for the operator to rule or send back.

## Composition with the round budget (K=3) and `healDeltaReview` (5472) — not a fork

Skeptic ruled this a non-fork: the other branches (folding into the budget, or extending delta review to fixer pushes) violate the non-goals and the 5472 ruling, so only one branch remains. The composition is therefore a note:

- Budget K=3 acts before an accept; this rule acts at and after it. The round count stops at the accept. A PR accepted at round 2 gets the same card as one accepted at round 4.
- `healDeltaReview` still owns heal commits and merges of main, untouched. A fixer push forced by Fork 2 is not a heal commit, so it owes today's full review. Extending delta review to it would widen 5472, which its ruling excluded; revisit only with shadow data.
- Both settings keep their meaning and either can be off without breaking the other.

## Pre-mortem

Assume it shipped and failed. The likely stories:

1. Cards pile up and are never fixed (card debt). Mitigation: the count and the cards' fix rate are reported (build A3); one card per PR, not one per finding.
2. A real bug was classed `degraded` and merged. Mitigation: only confirmed broken, security or unknown block; shadow mode measures this before `on`; the end rule drops back to shadow on a traced defect.
3. A fixer or reviewer learns to label findings `degraded` to avoid a push. Mitigation: impact comes from the review verdict, not the PR author; finding text is data.
4. The shadow window is too small to show anything. Mitigation: 20 PRs or 14 days, whichever is later, and the replay of the three live PRs.
5. The card filing fails. Mitigation: the card is filed BEFORE the merge; if filing fails the accept is not merged and the PR stays parked, never merges silently.
6. Card debt grows without a cap. Mitigation: a card-debt trigger in the Fork 3 end rule drops the mode to shadow.

## Test and proof plan

- Test: replay fixtures on `review-loop-policy` (cases in build child x5vjl3o A1), including unknown impact, off, and shadow.
- Proof before/after, with the before figures: PRs #6158, #6033 and #6141 took 5 to 13 loops each and used 29% of all review loops. Replay their ledgers under the rule and print the loops removed. Target (proposal): each of the three at no more than the loops up to its first accept, plus at most one forced-push loop; the three PRs' share of all loops below 10%.
- Held-out check: after the replay, measure the next 20 accepted PRs in shadow (not the three used to design the rule) and report loops per PR against the 5 to 13 before figures.
- Forced-push loops in the target are counted as loops that start on a head pushed after an accept for a Fork 2 reason.
- Live proof: one accepted PR with advisory findings, before (post-accept push + full re-review) and after (one card, no new head).

## Trust boundary and threat model

The rule trusts review verdicts and ledger rows, never the PR author's text. Finding text is copied into the card as data. The risk is a downgraded impact; it is bounded by the fail-closed rule in Fork 2 and by shadow measurement. No new endpoint, no new untrusted input path.

## Acceptance

- [A1] The three defaults above (Forks 1 to 3) and the composition note are ratified or overridden by the operator; the build child x5vjl3o is then updated to match.
- [A2] The build child's A4 proof (replay of the three PRs plus one live PR) is attached before the mode moves from shadow to on.

## Non-goals

- [N1] No change to the round cap of 5, to K, or to 5472.
- [N2] No mechanics in this card; they live in x5vjl3o.

## Edge cases this change must handle

1. **Untrusted text** — finding text is data in the card, never parsed for severity.
2. **Truncated reads** — unknown round or impact means push.
3. **Shared state files** — cards via `file-item`, counts via the existing ledger writer.
4. **Fail closed** — an error anywhere keeps today's behaviour.
5. **Identity scoping** — the accept is per PR, bound to the reviewed head.
6. **State over time** — a new head from anyone else voids the accept as today.
7. **Who wrote it** — impact is assigned by the review verdict only.
