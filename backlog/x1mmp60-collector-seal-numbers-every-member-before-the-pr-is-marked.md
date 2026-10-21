---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt"]
scope: ["we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector seal numbers every member before the PR is marked ready

Per decision x5ioz96 fork 5 (statute backlog-ids-numbered-before-publish): add a number-members seal step after record-sealed and before verify, calling the declared numbering operation once over the whole branch so sibling references resolve together. It fails closed: if numbering fails the batch stays held and never reaches ready.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-seal.test.mjs we:scripts/operations/__tests__/card-batch-seal-io.test.mjs` fails before this item lands and passes after. Planned cases:
  - `seal steps run record-sealed, number-members, verify, remove-hold, ready, label-on-green` (we:scripts/operations/__tests__/card-batch-seal.test.mjs).
  - `numbers all siblings in one pass so cross-references resolve` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — two members that name each other both carry the new numbers.
  - `numbering failure retains the hold and never reaches ready` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).

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
