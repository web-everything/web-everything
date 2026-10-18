---
kind: story
size: 5
parent: "x87psvt"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector coordinator retires a stuck sealed batch from GitHub truth

Priority: top (unblocking). Live: the prevention collector has been stuck since 2026-10-14. Batch 9 (PR 5272) merged but its state file kept sealedAt at seal step ready, so admission refuses every card with batch-sealed and the filer spools it: 327 cards spooled at 2026-10-18 08:06 ET. Fix: on the next admission, a sealed state whose PR is merged or closed on GitHub is retired under the existing lease (GitHub is the truth); an unreadable PR state fails closed and keeps the batch sealed and held, never retires. Proof required: before/after on the live 327-card spool draining into a fresh batch. [A1] Executable: node --test we:scripts/operations/__tests__/card-batch-seal-io.test.mjs and we:scripts/operations/__tests__/card-batch.test.mjs, where a sealed state with a merged PR retires on the next admission, a closed one retires, and an unreadable one stays sealed and held. Operator 2026-10-18 verbatim: All ok.

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
