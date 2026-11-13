---
bornAs: xe8x898
kind: story
size: 3
status: active
scaffoldedBy: "drain-workflow-hold-net-diff"
dateScaffolded: "2026-11-11"
dateOpened: "2026-11-11"
tags: []
related: ["6666"]
---

# Reinforce drain net-diff workflow hold: revalidate base SHA, ignore-submodules, staleness proof

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

residuals accepted under R896+R903 on the net-diff workflow-edit hold

no card yet covers these three audit residuals

## Residuals accepted under R896+R903 (net-diff workflow-edit hold)

1. Base SHA is not retained or revalidated: the net diff clears a hold against the base tip at read time; if main later moves, the same head is not rechecked before merge (merge-group CI still runs the real workflow).
2. `readPinnedChangedFiles` lacks `--ignore-submodules=none`: local git config could hide a changed gitlink under `.github/actions/` (the repo has no submodules today).
3. A non-empty net diff overrides a complete listing's hold without proving the listing is stale (for example by comparing the PR's recorded base to current main).

Fix each, with a test, without weakening the rule that a real workflow edit always holds.
