---
bornAs: xu7kxtt
kind: story
size: 3
parent: "5467"
status: open
blockedBy: ["5469"]
relatedTo: ["5468", "2979", "3024"]
scope: ["we:scripts/lib/git-patch-equivalence.mjs", "we:scripts/lib/review-need.mjs", "we:scripts/operations/review-pr.mjs", "we:.github/workflows/review-gate.yml", "we:scripts/conveyor/accept-carry-sweep.mjs", "we:scripts/conveyor/review-hold-reconcile.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/merge-gate-inventory.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/lib/review-label-provider.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs", "we:scripts/settings/accept-carry-forward.json", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-08"
tags: [review]
---

# Heal on an accepted PR keeps the accept; heal commit gets a delta review

Fixer/review proposal, operator 2026-10-08, P4. A merge of main that leaves the PR's own change identical (empty range-diff, via we:scripts/lib/git-patch-equivalence.mjs) keeps the earned accept. A heal commit gets a review of its own delta only: a delta finding blocks; old tolerated findings stay tolerated. Today a heal re-arms a full review: PRs 4484 and 4453 each lost a full round after acceptance. Builds on #2979 (content equivalence) and #3024. The "old tolerated stay tolerated" part needs 5469's finding identity; the merge-main part may land first inside this card. The rule is a pure function in the protocol card 5468's shape.

## Scope widened (operator 2026-10-11 ~07:50 ET)

Scope grew from operator rulings on PR #4631 (drain-owned mechanical park label; a later native "changes requested" review stops carry-forward). Operator approved widening the declared scope to the 11 code files PR #4631 actually changes.

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
