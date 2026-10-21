---
kind: story
size: 3
parent: "x87psvt"
status: open
scaffoldedBy: "fix-5608"
dateScaffolded: "2026-10-21"
blockedBy: ["xpabefb"]
scope: ["we:scripts/operations/land-ruling-card.mjs", "we:scripts/operations/card-batch-file.mjs", "we:scripts/lib/card-batch-policy.json", "we:scripts/operations/__tests__/land-ruling-card.test.mjs", "we:scripts/operations/__tests__/card-batch-file.test.mjs", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Collector ruling filer routes ruling cards into the ruling stream and enables it

Decision x5ioz96 fork 1 skeptic amendment: a card must wire the ruling filer to the collector, otherwise ruling stays declared and unused and rulings keep being hand-batched (lane/rulings-1018-cards). After xpabefb declares ruling disabled, add the ruling-card filer and flip the shipped default to enabled. No ruling filer exists today (rulings are hand-batched), so this card creates one: we:scripts/operations/land-ruling-card.mjs, the caller that files a ruling card through we:scripts/operations/card-batch-file.mjs with kind ruling. Flipping the default changes xpabefb's disabled-default case, so this card updates that case in we:scripts/lib/__tests__/card-batch-policy.test.mjs to assert enabled with 8 / 60.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/land-ruling-card.test.mjs we:scripts/operations/__tests__/card-batch-file.test.mjs we:scripts/lib/__tests__/card-batch-policy.test.mjs` fails before this item lands and passes after. Planned cases:
  - `land-ruling-card files through the collector with kind ruling` (we:scripts/operations/__tests__/land-ruling-card.test.mjs).
  - `ruling cards are admitted into the ruling batch, not filing` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `high and urgent ruling cards bypass the collector` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `ruling ships enabled with 8/60 defaults` (we:scripts/lib/__tests__/card-batch-policy.test.mjs) — replaces xpabefb's disabled-default case.

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
