---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Label-only approval has no actor check; marker from an older accept is reusable

Flow-sim gap C-G10, class K8 (authority asymmetry). Failing input: Head H has a trusted plain accept comment (reviewed-sha H), later sent back (review:changes label), head unchanged.' 'E1 anyone with label-write adds review:accepted and removes review:changes by hand Cited: we:scripts/lib/review-escalation.mjs:3075, we:scripts/lib/review-escalation.mjs:2361-2380, we:scripts/lib/review-escalation.mjs:1202, we:scripts/lib/review-escalation.mjs:3. Soak-break sketch: none

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
