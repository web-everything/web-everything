---
bornAs: xl3mmn5
kind: story
size: 3
parent: "x5wqxb3"
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/run-store.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 0: review-pr run identity is immutable (writeRun refuses a repo/PR change, no symlinked runs, safe legacy migration)

Prerequisite for the identity index (epic x5wqxb3), correct on its own. Today a fresh invocation with an existing --run-id overwrites a review-pr record with a different repo/PR unchecked, migrateLegacyRuns renames records in without writeRun (exists-then-rename overwrite race), and writeJsonAtomic follows symlinked run paths. Make writeRun refuse an input.repo/input.pr change for an existing review-pr id, refuse symlinked run paths, and route migration through the same check with no overwrite. Delivery mode: pr.

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
