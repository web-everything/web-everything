---
bornAs: xva0v9w
kind: task
status: open
scope: ["we:scripts/conveyor/build-dispatch-failures.mjs", "we:scripts/conveyor/build-dispatch-orphan-adopt.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# build-dispatch: expired group-member claim aliases must not mark a new lead failure as a duplicate

Ruling card from PR #5453 (operator 2026-10-17, confirmed red-team break, carded). In we:scripts/conveyor/build-dispatch-failures.mjs (~55): a group (lead 7101, member 7102) dies after its claims expire; orphan adoption records the failure and releases the lead but leaves the member; when lead 7101 is retried alone and dies again, claimAttemptKeys includes the old member alias, so recordBuildFailure treats the new failure as a duplicate and the retry budget is bypassed. Charge each new dispatch once regardless of stale member aliases (or release member claims with the lead), with a test for this exact sequence.

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
