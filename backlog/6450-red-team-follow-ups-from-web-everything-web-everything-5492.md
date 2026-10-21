---
bornAs: xbsqgzs
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-observation.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5492 (head 3d6d6345f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5492 (reviewed head `3d6d6345f31ed4e527b5a9bbf8d25c540c5c5e5b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-observation.mjs:87` — (failing-input, degraded) Carry proofs run beyond the observation deadline
   - Scenario: Observe B after accepted(A), with deadline=15000ms. Planning invokes proveLedgerCarry without passing the deadline; the deadline is checked only after planning finishes. An injected clock/exec probe through the actual carry functions reproduced a 28000ms observation: numbering's cat-file and fallback fetch each fail after their allowed 5000ms, then the two tree reads each take 9000ms within their individual 10000ms timeouts. The second tree read starts at 19000ms, already past the observation deadline. Only afterward does the observer report budget exhaustion. The remaining budget should bound
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/ledger-observation.mjs:165` — (failing-input, degraded) Unbaselined PRs can permanently starve enabled head-move invalidation
   - Scenario: Set firstSeenRows=false and headMoveInvalidation=true, retaining the default count cap of 20. Supply a stable ordered list of 21 PRs: the first 20 have no ledger rows; PR 21 has accepted(A) but now lists head B. Every pass spends all 20 observation slots on the unbaselined PRs, whose observations return no rows because firstSeenRows is disabled. PR 21 is capped every time, so its enabled invalidation never runs. A three-pass probe reproduced zero reads of PR 21 and its unchanged accepted(A) row. Disabled baseline work should be skipped before consuming observation slots, or capped work should
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
