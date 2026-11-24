---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/resource-pool.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7385 (head 9957f6376)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7385 (reviewed head `9957f6376f2073bc8a1ba2db5cfe09435749598b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/resource-pool.mjs:22` — (failing-input, degraded) The text CLI omits every shadow comparison decision and reason.
   - Scenario: Pass finishResourcePool a shadow report whose three rows have poolDecision='hold' and legacyDecision='grant', with a successful log sink. The production finish hook returns code 0 but its text contains neither decision: renderResourcePool never renders report.rows. Operators cannot see admission divergence in the default CLI output. Render each comparison row and its reason alongside the digest.
   - Class: live-reproduced (basis: Directly executed the production finishResourcePool function with the divergent report and a no-write sink. Observed successful output containing inventory totals but no grant/hold decisions. we:run.mjs binds this finish hook to resource-pool.)
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
