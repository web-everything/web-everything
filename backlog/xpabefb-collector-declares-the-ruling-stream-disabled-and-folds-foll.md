---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt"]
scope: ["we:scripts/lib/card-batch-policy.mjs", "we:scripts/lib/card-batch-policy.json", "we:scripts/operations/card-batch-file.mjs", "we:scripts/lib/card-batch-settings.mjs", "we:scripts/lib/__tests__/card-batch-policy.test.mjs", "we:scripts/lib/__tests__/card-batch-settings.test.mjs", "we:scripts/operations/__tests__/card-batch-file.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector declares the ruling stream disabled and folds follow-up and expedite cards into filing

Per decision x5ioz96 forks 1 to 3: add ruling to CARD_BATCH_KINDS with policy enabled false, maxCards 8, maxAgeMinutes 60, highPriorityBypass true; keep prevention at 10 cards / 120 min and filing at 10 / 60; a follow-up or expedite-origin card routes to the filing stream; high and urgent cards keep bypassing via highPriorityBypass. No filer routes to ruling here: wiring the ruling filer and enabling the stream is x7nf3f5 (the fork 1 skeptic amendment).

## Acceptance

- [A1] **Executable** — `node --test we:scripts/lib/__tests__/card-batch-policy.test.mjs we:scripts/lib/__tests__/card-batch-settings.test.mjs we:scripts/operations/__tests__/card-batch-file.test.mjs` fails before this item lands and passes after. Planned cases, each asserting the shipped defaults with no override:
  - `ruling is declared with disabled 8/60 defaults` (we:scripts/lib/__tests__/card-batch-policy.test.mjs) — and prevention stays 10/120, filing 10/60.
  - `count wins simultaneous count and age thresholds` (we:scripts/lib/__tests__/card-batch-policy.test.mjs).
  - `every stream value is a cascade setting with its source logged` (we:scripts/lib/__tests__/card-batch-settings.test.mjs) — a repo override of ruling's maxCards wins and the log names its source. Today the cascade (`effectiveCardBatchPolicy` in we:scripts/lib/card-batch-settings.mjs) maps only filing and prevention, so this card extends it to ruling.
  - `disabled ruling refuses kind-disabled, not unknown kind` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `follow-up and expedite origins route to filing` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `high and urgent bypass with shipped defaults` (we:scripts/operations/__tests__/card-batch-file.test.mjs).
  - `code changes refuse collection` (we:scripts/operations/__tests__/card-batch-file.test.mjs) — statute rule 1: a non-card change is refused `ineligible-change`.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No filer routes to ruling and the stream ships disabled; x7nf3f5 wires and enables it.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the inputs are the policy JSON and the origin field set by filers; an unknown origin routes as it does today.
2. **Truncated reads** — an invalid or partial policy is refused `invalid-policy`, as today.
3. **Shared state files** — n/a: the policy is read-only config.
4. **Fail closed** — a disabled stream refuses `kind-disabled`, distinct from an unknown kind (case `disabled ruling refuses kind-disabled, not unknown kind`).
5. **Identity scoping** — each stream has its own policy block; routing is by the card's origin.
6. **State over time** — n/a: no stored state.
7. **Who wrote it** — n/a: config and routing only; who may file a ruling card is x7nf3f5's.
