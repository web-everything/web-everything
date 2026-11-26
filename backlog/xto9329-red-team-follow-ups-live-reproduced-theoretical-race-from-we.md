---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/delivery-strategy.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7492 (head 02fa20b28)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7492 (reviewed head `02fa20b284b0e8f0a661490867053b3296abf094`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/delivery-strategy.mjs:54` — (edge-case, degraded) Submillisecond future observations incorrectly authorize a strategy
   - Scenario: Use the first replay candidate with every observedAt set to 2026-11-25T11:00:00.0009Z and fresh=true, then select at 2026-11-25T11:00:00.0001Z. Date.parse truncates both instants to milliseconds, so selection returns R3/prototype-first/build=true and decisionFindings accepts the corresponding record. These observations are in the future and should produce unhandled/EVIDENCE_UNKNOWN. Preserve fractional precision or reject unsupported precision.
   - Class: live-reproduced (basis: A read-only Node probe reproduced prototype selection and an empty decisionFindings result using the shipped table, settings, and replay candidate.)
   - Also class: theoretical-race
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
