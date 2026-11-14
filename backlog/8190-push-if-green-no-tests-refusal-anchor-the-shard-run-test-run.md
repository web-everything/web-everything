---
bornAs: xy9heg4
kind: story
size: 1
status: open
dateOpened: "2026-11-13"
tags: []
---

# push-if-green no-tests refusal: anchor the shard-run test-runner check in verify-lane-gate (#6769 red-team, R903)

Red-team break on #6769 (R913 related-tests gates): in a checkout whose only script is check:standards, a changed file named we:src/shard-run.ts makes the unanchored shard-run check in we:scripts/lib/verify-lane-gate.mjs treat the filename as evidence of a test runner, so the default push gate returns exit 0 with testCommand null instead of refusing (exit 2). Fix: anchor the check to the command tokens, not --files, and add a test with a shard-run filename. Carded per R903/R913: not worse than main.

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

Searched backlog for shard-run, verify-lane-gate, push-if-green: no card covers the unanchored shard-run regex added by #6769
