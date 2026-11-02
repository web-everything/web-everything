---
bornAs: xu7kxtt
kind: story
size: 3
parent: "5467"
status: open
blockedBy: ["5469"]
relatedTo: ["5468", "2979", "3024"]
scope: ["we:scripts/lib/git-patch-equivalence.mjs", "we:scripts/lib/review-need.mjs", "we:scripts/operations/review-pr.mjs", "we:.github/workflows/review-gate.yml", "we:scripts/conveyor/accept-carry-sweep.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/merge-gate-inventory.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/lib/review-label-provider.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs", "we:scripts/settings/accept-carry-forward.json", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/review-settings.json"]
dateOpened: "2026-10-08"
preparedDate: "2026-11-01"
preparedAgainstSha: "174220fad20252329d315759de9702bbcc698979"
tags: [review]
---

# Heal on an accepted PR keeps the accept; heal commit gets a delta review

Fixer/review proposal, operator 2026-10-08, P4. A merge of main that leaves the PR's own change identical (empty range-diff, via we:scripts/lib/git-patch-equivalence.mjs) keeps the earned accept. A heal commit gets a review of its own delta only: a delta finding blocks; old tolerated findings stay tolerated. Today a heal re-arms a full review: PRs 4484 and 4453 each lost a full round after acceptance. Builds on #2979 (content equivalence) and #3024. The "old tolerated stay tolerated" part needs 5469's finding identity; the merge-main part may land first inside this card. The rule is a pure function in the protocol card 5468's shape.

## Slice 1 — merge-main carry-forward (2026-10-09, urgent: merge queue #4619)

Live trigger: #4535 was cleared by the operator at fcc29ce1; the merge queue refreshed it to 143107a87 (net diff byte-identical, reviewed-diff b945d333…); the drain's anti-test-gaming gate re-parked `review:human` and the review daemon paused on the same head, so it waited for a second approval. Delivered: the pure rule `decideAcceptCarryForward` (we:scripts/lib/accept-carry-forward.mjs; strict reviewed-diff only), the setting `acceptCarryForward` (cascade x5wnfcg; built-in off, platform on), the drain gate honouring a carried clearance, `restamp` crossing a mechanical `review:human` re-hold only with that proof, the review daemon's carry sweep, and the #4535 replay fixture. Still owed here: the delta review of a heal commit's own diff (A1 b-d) — a changed net diff falls back to today's full review.

## Scope widened (operator 2026-10-11 ~07:50 ET)

Scope grew from operator rulings on PR #4631 (drain-owned mechanical park label; a later native "changes requested" review stops carry-forward). Operator approved widening the declared scope to the 11 code files PR #4631 actually changes.

## Digest (prepared 2026-11-01, R357)

Slice 1 is delivered (equivalent merge-main keeps the accept; `acceptCarryForward`, `we:scripts/lib/accept-carry-forward.mjs:48`).
What is owed is acceptance [A1] b-d: a heal commit on an accepted PR owes a review of its own delta only, not a full round.
Scoped delta review already exists as a pure rule: `reviewScope({ priorHead, head, delta })` returns `kind: 'delta'`
(`we:scripts/lib/review-round-rules.mjs:178-187`), and the shadow journal shows 2520 of 2521 later rounds scoped `delta`
(`<ops>/ledger-shadow/scoped-rereview.jsonl`), so the delta computation is proven; only its use on a heal is missing.
The decision is how that use is switched. **Bold default: Fork 1 (a), its own declared setting `healDeltaReview`.**

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| Fork 1 - how the heal delta review is switched | (a) own setting `healDeltaReview` (off/on), built-in off | (b) ride on `scopedRereview: on` | High |

## Fork 1 - own setting, or ride on `scopedRereview`?

*Fork-existence:* the excluded branch is (b): it is blocked while #7602 (the B1 flip) stays `shadow` - with `scopedRereview`
at `shadow` or `off`, a heal on an accepted PR would keep paying a full round, so A1 b-d could never ship, and the delta review
of a heal would be held hostage by an unrelated ruling about later-round findings. Both settings read the same `reviewScope`,
so they cannot be one switch without coupling two different risks (heal delta: narrow, one commit; scoped re-review: every later round).

- **(a) Own setting `healDeltaReview` (`off` | `on`), built-in `off`, declared in `we:scripts/review-settings.json`.** Reuses `reviewScope`
  with `priorHead` = `lastReviewedHead(reviewRuns, head)` (we:scripts/lib/review-round-rules.mjs:147, the latest ledger-reviewed head, which is the accept head only when no other head was reviewed since), and `sentBack` empty. A heal is identified by the durable CI-heal comment (`CI_HEAL_COMMENT_MARKER`, we:scripts/conveyor/ci-heal-mark.mjs:42), not by commit authorship (none exists today); the setting must also be added to `BUILT_IN_REVIEW_SETTINGS`/`ALLOWED` in we:scripts/lib/review-settings.mjs:48-54 (scope omits it).
  A delta finding blocks (A1 c); an unreadable delta falls back to the full review (edge 4).
- **(b) Ride on `scopedRereview: on`.** Fewer settings, but see fork-existence.

```json
// we:scripts/review-settings.json (a)
{ "scopedRereview": "shadow", "healDeltaReview": "on" }
```

**Rollback:** set `"healDeltaReview": "off"`; the next heal pays a full review, as today.
**Pre-mortem:** a heal commit changes behaviour outside its delta (a rename that breaks a caller); the delta review misses it.
Mitigation: v1 does not widen the scope to the changed files' importers; CI and the drain's live check still run (N1), so
a break is caught there, and the rollback is the setting.

Skeptic: HOLDS - default kept (b is only blocked while B1 stays shadow, no existing setting covers a heal delta; citations and the 2520/2521 journal count verified); corrected how priorHead is derived (last ledger-reviewed head) and how a heal is identified (CI-heal comment marker, not authorship), and noted we:scripts/lib/review-settings.mjs missing from scope.
Screen: clear

## Acceptance

- [A1] **Executable** — replay fixtures: (a) accepted PR + equivalent merge-main keeps the accept with no review owed; (b) accepted PR + heal commit owes a delta review scoped to the heal diff; (c) a delta finding blocks; (d) a previously tolerated finding outside the delta stays tolerated.
- [A2] A non-equivalent merge (range-diff not empty) owes a review as today.
- [A3] The mode is a declared setting; off = today's full re-review after any heal.
- [A4] **Proof** — on a live accepted PR that gets a heal, before/after: the accept is kept (or only a delta review runs) instead of a full round.

## Non-goals

- [N1] No change to CI or the drain's live re-check; both still run.
- [N2] No change to how heals are made (ci-heal) — only to what review they owe.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the rule reads diffs and ledger rows, not PR text.
2. **Truncated reads** — an equivalence check that cannot complete counts as "not equivalent": a review is owed.
3. **Shared state files** — n/a: no new state file; verdicts go through the existing ledger writer.
4. **Fail closed** — any error in the range-diff or delta computation falls back to the full re-review.
5. **Identity scoping** — the accept is bound to the PR's own patch identity, not to the head sha.
6. **State over time** — n/a: no time rule.
7. **Who wrote it** — only a commit marked by the conveyor CI-heal comment counts as a heal commit; any other new commit owes a normal review.

## Ratified — 2026-11-01 (R360)

Operator chalbert, 2026-11-01 18:05 ET, verbatim: "Ratify all three".

Decision: its own setting `healDeltaReview`, default off, independent of the B1 flip (7602). Open as a build-ready story.
