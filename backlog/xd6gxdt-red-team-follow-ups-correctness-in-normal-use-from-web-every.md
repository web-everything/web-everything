---
kind: story
size: 2
status: open
scope: ["we:design-systems/constellation.tokens.json"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7350 (head b9523b44d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7350 (reviewed head `b9523b44d6d2ad0e2b436aba8eaad58ace4e75c8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:design-systems/constellation.tokens.json:124` — (edge-case, degraded) Day-theme “Needs you” text fails contrast on selected and hovered rows.
   - Scenario: Render a 13px status label using day signal-needs-you (#b4521f) on surface-raised (#efecf9), the documented ground for hover rows and selected lanes. The contrast is 4.32797:1, below the required 4.5:1 for normal text. Darken the signal or provide a compliant pairing, and include this combination in the contrast checks.
   - Class: correctness-in-normal-use (basis: A read-only Node assertion reproduced the contrast failure using the committed token values and the test suite’s luminance formula. This combines documented status-text and row-background uses; no rendered consumer failure is claimed.)
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
