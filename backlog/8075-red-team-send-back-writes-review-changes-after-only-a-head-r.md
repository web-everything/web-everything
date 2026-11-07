---
bornAs: xb5nlnk
kind: story
size: 2
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# red-team send-back writes review:changes after only a head re-read

Flow-sim gap R4-G6, class K6 (check-then-act race with no pin). Failing input: red-team result for head H with confirmed breaks, PR lacks review:changes. author pushes head H2 between `io.readHead` and the label write. Cited: we:scripts/operations/red-team-gate-apply.mjs:195-197. Soak-break sketch: wrong-bounce. review:changes lands on H2 carrying findings of H; one wasted fix round (the fixer sees an already-fixed head). Not a wrong-merge: changes only holds.

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
