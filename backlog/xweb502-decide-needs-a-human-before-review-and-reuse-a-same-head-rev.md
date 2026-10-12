---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Decide needs-a-human before review, and reuse a same-head review as the advisory

Held finding 218 (2026-10-10, operator OK). Live #4763: unattended review accepted 17:11 ET, flipped ready-to-merge, drain parked it gate-self at 17:24 (review:human + awaiting-advisory), mutual exclusivity removed review:accepted, then it waited for a second identical advisory run. Fix: (a) compute humanRequired from the touch-set shape before review and label review:human up front; (b) setting review.reuseAcceptAsAdvisory (cascade, default on): when a PR turns human-required, the latest review on the same head counts as its advisory iff its seated lenses/rounds meet what the shape earned, else re-run; (c) status labels follow (no stale status:ready-to-merge).

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
