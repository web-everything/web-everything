---
bornAs: x4fn2iw
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# editing an old trusted comment wakes a parked review as a fresh operator request

Flow-sim gap R4-G4, class K9 (divergent predicates for one state). Failing input: parked review run (or spent persist-retry budget) on head H; thread has an old operator comment or a REARM / 'changes requested' marker comment. that comment is edited (typo fix, or any tool that PATCHes it; the drain itself edits its park comment in place, we:merge-ai-prs.mjs:4801). GitHub bumps updatedAt, createdAt unchanged. Cited: we:scripts/conveyor/review-referral-hold.mjs:208, we:scripts/review-set-label.mjs:2781-2785. Soak-break sketch: double-act. A new full review panel (or a revived persist-retry budget) from an edit that carries no new request.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
