---
bornAs: x78233q
kind: story
size: 2
status: open
scope: ["we:review-pr.mjs", "we:fix-context-pack.mjs", "we:fix-round-history.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Health-watch piece I (PR read sharing) WAITS

MED priority hint. - (MED, 11-02 09:05 ET) Health-watch piece I (PR read sharing) WAITS: needs 8 consumer edits the prep missed (we:review-pr.mjs, we:fix-context-pack.mjs, we:fix-round-history.mjs, we:review-pr-io.mjs [held #6218], we:review-detail.mjs; drain: we:merge-ai-prs.mjs [entangled], we:forge-land-provider.mjs, we:reconcile-pass.mjs [held incremental-planner]). Split: I-a libs + review wiring after #6218; I-b drain wiring after #8 planner, cut merge-ai-prs delta clean.

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
