---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-stall-sweep.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7600 (head 3a368867a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7600 (reviewed head `3a368867a1bac125d3e758cc9d9d046b003b51c8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-stall-sweep.mjs:378` — (edge-case, degraded) The production PR job discards audit-repair items when the same PR has an invariant violation.
   - Scenario: Use a corrupt audit row and an open PR labelled review:changes whose state began three hours ago. The sweep creates repair-audit-history, but runPrSweep classifies the PR as deadline-passed. Its digest composition prioritizes the invariant item and removes the repair item for that PR. The operator feed receives action fix without the corruption evidence, while automatic actions remain blocked. Audit repair guidance should survive this composition and take priority over the generic invariant action.
   - Class: live-reproduced (basis: Executed the production digest-composition code with the real evaluateInvariant function and this input. Output contained only deadline-passed/action fix and repairVisible was false. This bounded probe bypassed filesystem/feed delivery and unrelated annotation; the full job import was blocked by missing markdown-it.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
