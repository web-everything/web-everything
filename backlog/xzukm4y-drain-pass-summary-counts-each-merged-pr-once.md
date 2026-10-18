---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs-summary.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Drain pass summary counts each merged PR once

Live: "merged 2 (#5522, #5522)" at 22:15Z and "merged 2 (#5517, #5517)" at 22:48Z. Each was one PR. The pass summary counts the same PR twice, which inflates the merged numbers the delivery metrics read. Fix: count distinct PR numbers. [A1] Executable: node --test we:scripts/__tests__/merge-ai-prs-summary.test.mjs, where one PR merged twice in a pass reports merged 1.

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
