---
bornAs: xx4qokc
kind: story
size: 2
status: open
scope: ["we:scripts/pr-land.mjs", "we:scripts/operations/open-pr-io.mjs", "we:scripts/lib/pre-pr-review.mjs", "we:.claude/skills/"]
dateOpened: "2026-10-07"
tags: []
---

# Pre-PR review gate also enforced on direct pr-land calls

Ruled card on #4271 security finding we:scripts/operations/open-pr-io.mjs:110 (operator 2026-10-07): the pre-PR review gate lives only in the open-pr wrapper, and several skills (pr, finish, batch-backlog-items, harvest-learnings) tell agents to run we:scripts/pr-land.mjs directly, which skips it. Move the receipt check into the shared pr-land path (or route those skills through open-pr) so enforce mode has no documented bypass; tests: direct pr-land on a risky head without a receipt is refused.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
