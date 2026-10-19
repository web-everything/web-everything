---
bornAs: xdbo9nr
kind: story
size: 5
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/settings/drain-queue-safety.json"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting: keep a red-team result whose comment failed to post; the drain hold reads the saved result

Priority: top (operator 2026-10-17). Build after #5482, #5480 and #5462 land (they hold the drain and red-team-gate files). 175 of 1,283 red-team runs (14%) leave no comment (105 withheld by the secret scrub, 56 errored, 14 not posted); the gate then records no-red-team-on-head (168 times) and the drain holds silently: 27 episodes, 831 min, median 29.3, p90 59. #5461 (1 confirmed break, comment error) and #5486 (2 confirmed breaks, comment withheld). Spec: a result that fails to post its comment is kept. The drain hold reads the saved red-team result (evidence row) for the head as well as the comment, using the existing readers. A saved result with no confirmed breaks satisfies the hold. A saved result with confirmed breaks is treated exactly as a posted one. Test: a saved result with breaks still holds. Operator 2026-10-17: Ok. Never weaken a hold. Tests first, run red, one per setting. A cascade setting with its source logged.

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
