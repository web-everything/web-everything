---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/resource-pool.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7385 (head 85873d924)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7385 (reviewed head `85873d92475df037bd50714480b3daf6bd7e3fa9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/resource-pool.mjs:38` — (failing-input, degraded) Text-mode resource-pool output omits every admission comparison
   - Scenario: Collect five successful sources with a 30-unit snapshot budget, no holders, and legacy admission returning hold. Pass that report through finishResourcePool with json=false and a successful sink. All three recorded rows say poolDecision=grant and legacyDecision=hold, but stdout shows only inventory totals. The advertised comparison readout should display each kind's pool decision, legacy decision, and reason so disagreements are visible.
   - Class: live-reproduced (basis: Executed the production collector and CLI finish/renderer in a read-only Node harness with injected source readers and an in-memory log sink. Confirmed three logged disagreements and no decisions in stdout.)
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
