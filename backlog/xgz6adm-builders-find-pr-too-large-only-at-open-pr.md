---
kind: story
size: 2
status: open
scope: ["we:scripts/worker-brief.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Builders find pr-too-large only at open-pr

MED priority hint. ## (held 2026-10-25 15:20 ET) Builders find pr-too-large only at open-pr Three builds today (3610+4010 at 475 lines, 5113 at 427, 5754 at ~1600) each did all the work and only hit the 300-line pr-too-large refusal at open-pr, costing a re-split per card. Fix: estimate the non-test size at claim/brief time from the card scope and size, and have the worker brief (we:scripts/worker-brief.mjs) require a split plan up front when the estimate exceeds the limit. Add a cheap mid-build size check, the same counter open-pr uses, before verify/converge.

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
