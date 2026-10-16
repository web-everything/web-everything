---
bornAs: xspk8i2
kind: task
status: open
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-10-15"
tags: []
---

# a drafted PR whose CI went green is un-drafted and sent to review

Live case PR #5283 (2026-10-15): ci-heal pushed a repair at 2026-10-14 19:54Z; every required check then went green, but the PR stayed a draft labelled status:awaiting-ci / review-status:awaiting-ci for 22 h and review never dispatched. Whoever drafts a PR (ci-heal / fix) must un-draft it and move it to review once CI on its head is green, and the PR movement sweep must flag a draft with green CI. Test with the #5283 shape.

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
