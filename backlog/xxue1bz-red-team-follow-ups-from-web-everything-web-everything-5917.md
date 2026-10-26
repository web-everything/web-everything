---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/coroner-stuck-trigger.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5917 (head 76b2b912c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5917 (reviewed head `76b2b912c8e38627cebe64e7bd4b9d519db33944`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/coroner-stuck-trigger.mjs:41` — (edge-case, degraded) Abbreviated SHAs count as separate rounds and fire false triggers
   - Scenario: For a 12-hour-old open PR with complete evidence, supply three trusted breaks-change review comments referencing the same commit using its 7-character, 9-character, and full SHA. A Node probe returned fix-causation:fired despite there being only one distinct round. Four commits each represented by full and abbreviated SHAs also returned fix-rounds:fired with observedRounds:8. The Set and rounds Map compare raw SHA strings. Resolve unambiguous prefixes to a common commit identity before counting; neither threshold should fire for these inputs.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/coroner-stuck-trigger.mjs:25` — (failing-input, degraded) Valid referral findings without line numbers never trigger recurrence
   - Scenario: Supply three trusted blocked referrals on distinct heads for the identical key ["judgeCorrectnessAdvisory","we:src/a.js","","missing guard"], with matching completed fix sessions between appearances. This empty-string line coordinate is the production format emitted by we:jury-core.mjs referralFindingKey when a finding lacks a line number. A Node probe returned recurrence:unknown; changing only the coordinate to 2 returned recurrence:fired. blockedKeys rejects the legitimate empty-string coordinate, suppressing the improvement card. It should accept the producer's optional-coordinate representation
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
