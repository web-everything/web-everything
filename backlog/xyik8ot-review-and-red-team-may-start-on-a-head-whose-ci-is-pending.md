---
kind: story
size: 5
status: open
scope: ["we:scripts/lib/review-timing.mjs", "we:scripts/lib/review-timing-settings.mjs", "we:scripts/lib/review-ci-gate-io.mjs", "we:scripts/settings/review.json", "we:scripts/lib/__tests__/review-timing.test.mjs", "we:scripts/lib/__tests__/review-ci-gate-io.test.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# Review and red-team may start on a head whose CI is pending (setting-gated, shadow first)

R464(1): the review gate in we:scripts/lib/review-timing.mjs reviewStartGate refuses while fast checks (standards, test-shard (1)) are pending, costing ~15 min per PR. Add review.startEarly off|shadow|on (default shadow: log would-start-early, change nothing) so review and red-team can start on a pending-CI head; verdict stays bound to the head; accept, ready-to-merge and merge keep requiring green CI on the same head; red CI never leads to ready-to-merge; early starts capped.

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
