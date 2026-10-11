---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4879 (head e2edfc247)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4879 (reviewed head `e2edfc24763ca3ef0021ea07ba9848e435ee5bf0`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:5882` — (failing-input, degraded) An unverified priority label suppresses a valid operator override
   - Scenario: Supply prLabels=['priority:low','priority:urgent'], with the low label added by web-everything[bot] and urgent added by operator chalbert. readOperatorOverride checks only names[0], returning low/byOperator=false and never considering the verified urgent label. Under enforce, the probe leaves this PR P3 behind an older ordinary PR. Reversing only the label-array order makes it P0 and puts it first. Unverified labels should be excluded before selecting the operator override; the sole verified urgent label should take effect regardless of listing order.
   - Claude's re-check: readOperatorOverride filters to override labels, then reads only names[0]. With ['priority:low','priority:urgent'] it checks only the low label's actor. A bot actor gives byOperator=false, and the operator-set urgent label is never examined. Reversing the array order changes the result.

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
