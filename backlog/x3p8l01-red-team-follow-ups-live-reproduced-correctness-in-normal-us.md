---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/resource-pool.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7385 (head 72afa8b8d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7385 (reviewed head `72afa8b8db3a7aee505ef05927065abc28eb9580`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/resource-pool.mjs:22` — (failing-input, degraded) Default text output omits every pool-versus-legacy comparison row
   - Scenario: With complete sources, budget 5, no holders and builderFloor 4, the collector produces a fix row with poolDecision=hold, legacyDecision=grant and reason=builder floor. The non-JSON CLI finish path prints only inventory and the digest, hiding this disagreement. It should also print the comparison decisions and reasons, as the PR's acceptance criteria require.
   - Class: live-reproduced (basis: A read-only Node probe invoked the actual finishResourcePool and renderer. Reports differing between a fix hold/grant disagreement and grant/grant agreement produced identical text output with exit code 0.)
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
