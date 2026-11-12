---
bornAs: x6krzgo
kind: story
size: 2
status: active
scaffoldedBy: "card-ruling-non-regression"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/operations/record-referral-ruling-io.mjs"]
dateOpened: "2026-11-11"
tags: []
---

# card-ruling: persist --notWorseThanMain evidence when two-step filing reuses an existing card

Residual from the R903 audit: when two-step card filing reuses an existing card (we:scripts/operations/record-referral-ruling-io.mjs:329), the card is not updated and no ruling is posted, so the not-worse-than-main evidence is only recorded if the later --card ruling repeats it. Require or carry the evidence on the --card call after a two-step filing that used the flag.

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
