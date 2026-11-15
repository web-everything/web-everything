---
bornAs: x9amt8q
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Auto-resolve of a referral hold must not re-apply review:accepted while a confirmed red-team send-back is open on that head

we:scripts/conveyor/review-referral-hold.mjs (2026-11-15 02:13 ET, HIGH): on #6844 review:changes (04:58Z) became review:accepted (05:06Z) on the same head 549387d4, leaving the PR accepted, ready and red-team:blocked, never fixed. Auto-resolve and resume must not flip to accepted while a confirmed red-team send-back is open on that head. Prove on the live case with before/after evidence, not only unit tests.

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
