---
kind: story
size: 5
parent: "5467"
status: open
scope: ["["we:scripts/lib/review-timing.mjs"", ""we:scripts/lib/review-timing-settings.mjs"", ""we:scripts/lib/__tests__/review-timing.test.mjs"", ""we:scripts/lib/__tests__/review-timing-settings.test.mjs"]"]
dateOpened: "2026-11-01"
tags: []
---

# Shadow-mode eligibility rules for starting review and fixer while CI runs

Build the shadow half of decision xrz0ezn (R359): cascade settings for care band, diff size and kind limits, plus a gate that logs would-have-started-early versus would-have-waited beside the real review and fixer decision, without acting. All new settings default off; every missing input waits for CI. Includes the end rule (wasted-start rate at or below 10%, 7 days, 30 PRs). Acceptance: vitest cases in review-timing and review-timing-settings tests for eligibility by care none/low only, docs/config/data kinds wait, missing care/size/kind/verify/CI state waits, shadow logs without acting, settings resolve through the cascade and default off, merge refuses with CI pending, a head move voids.

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
