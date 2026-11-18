---
bornAs: xnkvnz4
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/advisory-label-sweep.mjs", "we:scripts/lib/red-team-status-labels.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Sweep applies red-team labels computed for the old head onto a PR that moved during its own publish step

Flow-sim gap B-C7, class K6 (check-then-act race with no pin). Failing input: Snapshot head A, labels red-team:pending. Status file for A: finished/ran with comment 'withheld' (needs publish). Sweep reads live (head A) at we:advisory-label-sweep.mjs:178. publishStored runs (:194, gh comment list + post) and the author pushes head B before :206. Cited: we:scripts/conveyor/advisory-label-sweep.mjs:178, we:scripts/lib/red-team-status-labels.mjs:37-38. Soak-break sketch: wrong-clear (transient): B briefly carries A's red-team:clear (or blocked). Repaired the next tick because the PR carries a red-team label and is re-nominated (we:advisory-label-sweep.mjs:172-173). Matters only if delegated-clear-human or an admission read la…

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
