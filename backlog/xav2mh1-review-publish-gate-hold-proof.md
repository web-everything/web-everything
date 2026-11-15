---
kind: task
status: active
scaffoldedBy: "review-verdict-gate-deadlock-lane-31-ecc1228f"
dateScaffolded: "2026-11-15"
dateOpened: "2026-11-15"
tags: []
---

# Reinforce review publish gate: tell infra review-gate failure from a review hold

The accept publish now ignores a plain-failure review-gate and an annotated merge-gate hold (PR for #6769). Codex audit residuals: an infra failure of review-gate is indistinguishable from a review hold, and merge-gate-hold-class accepts incomplete verdict tables. Prove the hold from the verdict table or job evidence before exempting.

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
