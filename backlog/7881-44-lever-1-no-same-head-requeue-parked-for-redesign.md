---
bornAs: xouisvz
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# #44 lever 1 (no same-head requeue) PARKED for redesign

HIGH priority hint. - (HIGH, 11-02 13:28 ET) #44 lever 1 (no same-head requeue) PARKED for redesign: branch lane/mq-no-requeue-same-head d1c82a7ac0 (130 tests; success-only release, run_attempt-1 cancel exemption). Mapping merge_group RUNS back to a PR head is inherently lossy (no PR link; group sha ≠ PR head) → every audit round finds a new ambiguity (page coverage, missing head_branch, parent fallback). Redesign: read the PR's own timeline RemovedFromMergeQueueEvent (reason + commit) via GraphQL — head-bound and authoritative; hold when the latest removal for the current head is a failure, release only on a new head; any unreadable → hold.

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
