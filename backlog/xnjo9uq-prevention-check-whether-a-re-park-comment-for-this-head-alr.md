---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/human-surface-repark.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/conveyor/__tests__/human-surface-repark.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Check whether a re-park comment for this head already exists before posting. Add a sweep test wit… (from web-everything/web-everything#5273 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/human-surface-repark.mjs:82` — Check whether a re-park comment for this head already exists before posting. Add a sweep test with a throwing `setLabels` and two ticks.
2. `we:scripts/conveyor/human-surface-repark.mjs:60` — Make the sweep read files through `readPinnedChangedFiles`, or add a parity test that the sweep and gate classify the same renamed-out-of-workflow fixture identically.
3. `we:scripts/conveyor/human-surface-repark.mjs:58` — Build the sweep's change list with `readPinnedChangedFiles` (or `previous_filename` plus a truncation check). Add a test that a rename out of a human-only path still triggers re-park.
4. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:823` — Add a deterministic assertion comparing the two mocks’ invocationCallOrder values, or record their calls in a shared sequence and assert re-park precedes reconciliation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5273@0e3ecc1534a1b71df837b4f3100a6871fd32c73d

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
