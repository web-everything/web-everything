---
bornAs: xwfvby0
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/operations/land-advance-io.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# ci-heal budget follow-ups: one shared counter, fail closed on bad timestamps

Held finding 241 (2026-10-11, from #4880 approval). (a) the heal-budget reset applies only in planReconcile; we:scripts/conveyor/tick-core.mjs and we:scripts/operations/land-advance-io.mjs still count every ci-heal comment: share one counter; (b) healCommentsSince fails open on a missing/unparseable createdAt (NaN) and refunds a heal (we:scripts/conveyor/reconcile-core.mjs ~:480): fail closed; (c) test explicit ciHealCap wins + CodeQL path wiring; (d) test that fix rounds cap heal/fix alternation; (e) test a superseded older failure.

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
