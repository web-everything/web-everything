---
bornAs: xu7kxtt
kind: story
size: 3
parent: "5467"
status: open
blockedBy: ["5469"]
relatedTo: ["5468", "2979", "3024"]
scope: ["we:scripts/lib/git-patch-equivalence.mjs", "we:scripts/lib/review-need.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/settings/accept-carry-forward.json", "we:scripts/conveyor/accept-carry-sweep.mjs", "we:scripts/review-set-label.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-08"
tags: [review]
---

# Heal on an accepted PR keeps the accept; heal commit gets a delta review

Fixer/review proposal, operator 2026-10-08, P4. A merge of main that leaves the PR's own change identical (empty range-diff, via we:scripts/lib/git-patch-equivalence.mjs) keeps the earned accept. A heal commit gets a review of its own delta only: a delta finding blocks; old tolerated findings stay tolerated. Today a heal re-arms a full review: PRs 4484 and 4453 each lost a full round after acceptance. Builds on #2979 (content equivalence) and #3024. The "old tolerated stay tolerated" part needs 5469's finding identity; the merge-main part may land first inside this card. The rule is a pure function in the protocol card 5468's shape.

## Slice 1 — merge-main carry-forward (2026-10-09, urgent: merge queue #4619)

Live trigger: #4535 was cleared by the operator at fcc29ce1; the merge queue refreshed it to 143107a87 (net diff byte-identical, reviewed-diff b945d333…); the drain's anti-test-gaming gate re-parked `review:human` and the review daemon paused on the same head, so it waited for a second approval. Delivered: the pure rule `decideAcceptCarryForward` (we:scripts/lib/accept-carry-forward.mjs; strict reviewed-diff only), the setting `acceptCarryForward` (cascade x5wnfcg; built-in off, platform on), the drain gate honouring a carried clearance, `restamp` crossing a mechanical `review:human` re-hold only with that proof, the review daemon's carry sweep, and the #4535 replay fixture. Still owed here: the delta review of a heal commit's own diff (A1 b-d) — a changed net diff falls back to today's full review.

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
7. **Who wrote it** — only commits by the heal role count as a heal commit; any other new commit owes a normal review.
