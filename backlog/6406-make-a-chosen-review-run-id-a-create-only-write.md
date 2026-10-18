---
bornAs: x0dwug4
kind: story
size: 2
status: open
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Make a chosen review run id a create-only write

PR #5520 closes custom review run ids at the two CLI start sites: a chosen id is recorded idChosen, and its first record is saved create-only (the run store's createRun links a temp file into place, so of two starts with the same chosen id only one gets it; migrateLegacyRuns links the same way). What remains: the memory store and migrateLegacyRuns skip the review-run namespace check, a parked chosen-id run is still picked for resume, and a clean chosen-id run is refused under the unfinished-run code. Give the memory store and migration the same namespace check, skip custom runs in the resume picker, and give the refusal its own code. No producer passes --run-id for a review run today, so this is hardening.

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
