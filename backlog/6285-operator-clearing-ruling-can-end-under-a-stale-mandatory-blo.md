---
bornAs: xd994cj
kind: story
size: 2
status: active
scaffoldedBy: "fix-5550"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/operations/record-referral-ruling-io.mjs", "we:scripts/operations/__tests__/record-referral-ruling-ledger.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Operator clearing ruling can end under a stale mandatory block row in the verdict ledger

The operator ruling post effect appends a clearing (`not-real` / `card`) ledger row before it posts its comment, which is the F4 order. If review-pr's mandatory-referral sink is syncing at the same moment, it can append a `block` row computed from the thread before the comment, after the operator's row. Its settle re-read can run before the comment lands. The ledger then ends `blocking` while the thread counts the finding clear. This fails closed: it is a false hold, never a false clear. But nothing reliably re-runs review on that head, so it can last until a push. Found by the PR #5550 round-3 self-review.

## Acceptance

- [A1] **Executable** — a `record-referral-ruling-ledger` test: a stale `block` row lands between the clearing row and the comment, and the ledger must end `ruled`. A likely fix: re-append the clearing rows, with a fresh id, once the comment is confirmed readable. It fails today.

## Non-goals

- [N1] It keeps the F4 order (clearing row before the comment). It only adds a confirming row after the comment.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the rows carry hashed keys only.
2. **Truncated reads** — the confirming row is written only after the gate's own reader sees the comment.
3. **Shared state files** — the confirming row needs a stable id, so a re-run does not stack rows.
4. **Fail closed** — if the confirming append misses, warn; the earlier clearing row stands, as today.
5. **Identity scoping** — use the same hashed finding key as the referral row.
6. **State over time** — a later operator `block` must still win over the confirming row.
7. **Who wrote it** — source `record-referral-ruling`, unchanged.
