---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-loop-ticks.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7417 (head 5f725e936)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7417 (reviewed head `5f725e9368b87956ab2218645543b58a3a97d955`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/health-loop-ticks.mjs:65` — (failing-input, degraded) Short supported windows can alarm immediately
   - Scenario: Set WE_ZERO_SUCCESS_MINUTES=10 and supply three failed prepare records timestamped now, now minus one second, and now minus two seconds. runHealthTick opens an alarm after only two seconds because the required span is negative. It should require sustained failure over the configured window, with slack bounded appropriately for short windows.
   - Class: live-reproduced (basis: A read-only Node probe invoked the checked-out runHealthTick and observed an open episode reporting windowMinutes=10 and only two seconds of evidence.)
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
