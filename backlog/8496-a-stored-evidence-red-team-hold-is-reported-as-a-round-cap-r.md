---
bornAs: xlqllt3
kind: story
size: 2
status: active
scaffoldedBy: "fix-6622"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/operations/pr-sweep-core.mjs", "we:scripts/review-set-label.mjs", "we:scripts/operations/operator-queue.mjs"]
dateOpened: "2026-11-11"
tags: []
related: ["6622"]
---

# A stored-evidence red-team hold is reported as a round-cap ruling nobody can act on

A real conflict between stored red-team evidence and the posted comment holds the head as index 0 (PR 6622). redTeamRulingNeeded reports it (operator item 5e), but we:scripts/operations/pr-sweep-core.mjs labels it as 'red team round cap reached', the operator-queue ruling row offers a ruling command that rulableBreaks rejects, and we:scripts/review-set-label.mjs blocks clear-human with that reason. Give the index-0 hold its own wording and an actionable path (re-publish or operator review of the stored evidence).

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

PR 6622 index-0 hold is reported by redTeamRulingNeeded as required by the operator; its wording and ruling path are wrong
