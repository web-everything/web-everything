---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Comment, issue-event and review-clearance reads are re-paged on every reconcile

[held entry 321] (daemon-async-audit 2026-10-14, held) Comment, issue-event and review-clearance reads are re-paged on every reconcile. The review daemon made 9,651 api --paginate calls in 15.7 h (the biggest duplicated read). Complete-comment enrichment re-reads every PR with ≥100 comments on every defaultReadPrs call (we:pr-comments-complete.mjs:31), 3× per review tick. Each fix tick makes 47 review-clearance reads + 31 pr view (we:review-clearance-guard.mjs:153). The drain's readOperatorOverride (we:merge-ai-prs.mjs:5977) is uncached. Fix idea: one host-shared cache of comment threads and label timelines keyed by (PR, updatedAt / last comment id), with incremental since= reads; clearance verdict memo keyed by (PR, head SHA, last comment id). Design: shared cache. Saves 30–50 s per fix tick, est. 60–120 s per review tick. Size 3.

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
