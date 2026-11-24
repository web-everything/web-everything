---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/judge-sweep-facts.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7425 (head 634c4a520)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7425 (reviewed head `634c4a520aa155c79e9b4585277756c42a86b080`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/judge-sweep-facts.mjs:90` — (failing-input, degraded) Conflict ownership ignores the configured fixer hold label.
   - Scenario: Set WE_FIX_HOLD_LABEL=hold:repairs. Supply a non-draft CONFLICTING PR with labels ['hold:repairs'], no running fixer, no evidence errors, and minutesSinceUpdate=1. The production classifier returns needsJudgment=false, nextOwner='fixer', and 'Resolve the conflict.' The canonical hasFixHoldLabel helper recognizes this configured label as a hold. The conflict fallback should respect it, as it already respects the default hold:fix label, instead of recommending repair work on a held PR.
   - Class: live-reproduced (basis: A read-only Node probe executed buildJudgeSweepBundle with the environment override and input above and observed fixer ownership. The default hold:fix control returned nobody. Configurable hold semantics are established by hasFixHoldLabel in we:scripts/conveyor/fix-loop-ledger.mjs and its existing override test.)
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
