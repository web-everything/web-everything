---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch-extract.mjs", "we:scripts/operations/card-batch.mjs", "we:scripts/operations/card-batch-io.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Collector seal and coordinator: fix two red-team breaks from decision PR 5608 (number collision retargets a child's parent; split discards cards from an adopted fix commit)

Subject: cards 6941 and 6942 on decision PR 5608 (branch lane/decision-collector-pr). Operator R52 (chalbert, 2026-10-24): carded from the 5608 red-team round cap, not sent back. Break 1 (6942 line 20): a concurrent number collision during number-members can retarget a child's parent. Break 2 (6941 line 20): a split of a sealed batch discards cards that came from an adopted fix commit. Both need handling in the collector seal and coordinator, with a test each.

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
