---
bornAs: xd33aoo
kind: story
size: 2
status: active
scaffoldedBy: "fix-5460"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/await-verify.mjs", "we:scripts/verify-lane.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# await-verify reads a lane as dirty while its own verify run has the revert-red sources reverted

Live on PR #5460 (fix-5460, 2026-10-17 05:12Z): the harness resumed the fixer with 'lane-dirty' for sha 2640c4d42 while the verify for that same sha was still running its revert-red step, which had temporarily reverted the fix's source files in the lane. Minutes later verify restored them and went green, but the wait had already been dropped, so the fixer had to re-mark by hand. The await-verify dirty check should treat an in-flight verify (marker running for the marked sha) as not-dirty, or wait for the revert-red restore before judging the tree.

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
