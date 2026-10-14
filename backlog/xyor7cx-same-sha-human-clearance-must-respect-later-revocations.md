---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-escalation.mjs", "we:scripts/lib/__tests__/review-escalation-human-clear-same-sha.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Same-sha human clearance must respect later revocations

PR #5237 advisory: a later marker-free changes verdict, re-arm, stand-down or drain park can be skipped by the same-sha human-clearance parser. A subsequent plain accept can revive a clearance the operator revoked. Define and test the revocation boundary before carrying that clearance.

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
