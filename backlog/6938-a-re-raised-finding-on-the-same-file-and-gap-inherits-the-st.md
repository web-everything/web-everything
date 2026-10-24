---
bornAs: xek4odg
kind: story
size: 5
status: open
scope: ["we:scripts/lib/ruling-ledger.mjs", "we:scripts/conveyor/referral-auto-block.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# A re-raised finding on the same file and gap inherits the standing ruling

Live we:PR #5530: the security seat re-raised at backlog line 24 the same coverage gap the correctness seat raised at line 20, which already had a standing operator ruling. The ruling did not carry, so auto-policy blocked it again. A re-raised finding on the same file and the same gap should inherit the standing ruling. Needs a same-gap matcher in we:scripts/lib/ruling-ledger.mjs, fail closed when unsure, and new heads still fully reviewed.

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
