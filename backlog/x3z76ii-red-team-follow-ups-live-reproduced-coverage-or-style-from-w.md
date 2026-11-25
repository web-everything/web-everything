---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7492 (head e5dc531d3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7492 (reviewed head `e5dc531d3bca804cbd28fe35bf438c8ddf45c569`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/delivery-strategy.mjs:57` — (edge-case, degraded) Submillisecond future observations pass the temporal evidence guard.
   - Scenario: Take replay.points[0].candidates[0].inputs, set every observedAt to '2026-11-25T11:00:00.0009Z' and fresh to true, then select at '2026-11-25T11:00:00.0001Z'. Selection returns prototype-first with no unknown inputs, and its complete decision record passes validation. Observations are 0.8ms after the decision and should yield unhandled/EVIDENCE_UNKNOWN. The parser accepts arbitrary fractional precision but Date.parse truncates it to milliseconds.
   - Class: live-reproduced (basis: Direct Node probe reproduced selection and record acceptance for future evidence; a control with evidence 1ms in the future correctly returned unhandled.)
   - Also class: coverage-or-style
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
