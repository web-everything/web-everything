---
bornAs: x3gza29
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Label flapping: ready-to-merge removed and re-added every ~16 min on red-team-blocked PRs

MED priority hint. ## (held 2026-10-27 19:09 ET) Label flapping: ready-to-merge removed and re-added every ~16 min on red-team-blocked PRs labels-reconciled (the #5990 code on the review prototype) removed ready-to-merge from #6009 and #5990 at 22:42Z and again at 22:58Z (red-team:blocked). Something re-adds it between runs, a second writer. status:ready-to-merge also stays stale next to review:changes. Fix: find the re-adding writer and make it respect red-team:blocked (one source of truth for ready-to-merge); reconcile status:* with review:*. Prove it: no labels-reconciled repeat on an unchanged head.

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
