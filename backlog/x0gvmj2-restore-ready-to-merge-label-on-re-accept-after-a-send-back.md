---
kind: story
size: 3
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/pr-land.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Restore ready-to-merge label on re-accept after a send-back cycle; pr-land --label-on-green refuses an existing accepted PR

PR 6381 (accepted, red-team clear, MERGEABLE CLEAN) lost the ready-to-merge label during send-back / review:changes cycles; only the derived status:ready-to-merge remains, so the drain never lists it. Nothing re-applies the label on re-accept: we:scripts/review-set-label.mjs accept path never adds it, and the only adder we:scripts/pr-land.mjs --label-on-green refuses (no verify marker; would also push lane HEAD) so the sanctioned restore needs a bypass flag. Fix: a re-accept (acceptance covers live head, required checks green) re-adds ready-to-merge through one sanctioned step, with before/after proof on 6381. R907.

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
