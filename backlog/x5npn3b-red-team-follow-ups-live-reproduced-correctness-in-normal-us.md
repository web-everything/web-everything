---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-size-accounting.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7460 (head a3e2d9587)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7460 (reviewed head `a3e2d958702c0dcb00adc775ba271b8f02f0234e`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-size-accounting.mjs:51` — (failing-input, degraded) Digit-class globs without an asterisk never match
   - Scenario: Configure dataPaths as ['protocols/p/v[0-9]we:/traceability.json'] and pass numstat input '400\t0\we:tprotocols/p/v1/traceability.json\0' to planSizeGrowth. Settings validation accepts the pattern, but admission returns status 'over-cap' with 400 counted lines. The supported digit class should match v1, producing status 'ok' with zero counted lines. matchesDataPath only invokes the glob matcher when the pattern contains an asterisk.
   - Class: live-reproduced (basis: Reproduced using the checked-out resolvePrSizeSettings and planSizeGrowth exports in Node. Adding an asterisk after the digit class makes the same path correctly count as zero lines.)
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
