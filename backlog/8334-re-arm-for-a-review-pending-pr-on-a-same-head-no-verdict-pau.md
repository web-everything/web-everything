---
bornAs: x6f06sm
kind: story
size: 3
status: open
scope: ["we:scripts/operations/operator-controls.mjs"]
dateOpened: "2026-11-15"
tags: []
related: ["8253"]
---

# Re-arm for a review:pending PR on a same-head no-verdict pause, and wake heads whose attempts were spent under a rolled-back overlay

we:scripts/operations/operator-controls.mjs:77 (2026-11-15 06:25 ET, MED): 10 PRs (#6844..#6870) burned review attempts under the B16 regression; the we:scripts/operations/run.mjs rearm is a no-op because decideRearm only acts from review:changes, so they wait for the 12:55Z cool-down. Make rearm on a review:pending PR with a same-head hold post the REARM_COMMENT_MARKER wake (we:scripts/conveyor/review-referral-hold.mjs:238), and have a prototype rollback wake every head whose attempts were spent while the overlay was live. Prove on the live case with before/after evidence, not only unit tests.

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

## Duplicate admission

adjacent but distinct

different failure/behaviour
