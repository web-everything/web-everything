---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5863 (head 93c2e91cf)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5863 (reviewed head `93c2e91cfc760453c1a278f996ad372a75f8d1a6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-pr.mjs:2042` — (failing-input, degraded) Sanitization deletes comparison operators and corrupts the repair instruction.
   - Scenario: A recognized operator send-back says: In validateCount, replace 'count &lt; 0' with 'count &gt; 0'. With zero juror findings and no explicit reason, the fallback produces: In validateCount, replace 'count 0' with 'count 0'. A read-only Node probe executing the exact helper extracted from this checkout confirmed this output using an item returned by openOperatorSendBacks. The resulting bounce loses the distinction that specifies the required repair. Preserve comparison operators when safely rendering the excerpt.
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
