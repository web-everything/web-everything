---
bornAs: x4e888j
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/parked-pr-conflict-watch.mjs", "we:scripts/conveyor/rearm-review.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Conflict-resolved hand-back rearms ANY review:changes, even a real reviewer finding, with no head change

Flow-sim gap R9a-G3, class K9 (divergent predicates for one state). Failing input: PR labels review:changes (a genuine reviewer finding, fixer not yet started or between rounds) + merge-status:conflicting (label added when GitHub reported CONFLICTING), head unchanged, no live fix session. 'GitHub later reports mergeable MERGEABLE (main churn, reverted base, or mergeability recompute flicker). No push to the P… Cited: we:scripts/conveyor/parked-pr-conflict-watch.mjs:1434-1436, we:scripts/conveyor/parked-pr-conflict-watch.mjs:2048, we:scripts/conveyor/parked-pr-conflict-watch.mjs:2115-2117, we:scripts/conveyor/rearm-review.mjs, we:scripts/review-set-label.mjs:512-560. Soak-break sketch: Fixture: labels [review:changes, merge-status:conflicting], mergeable MERGEABLE, thread has a reviewer finding comment and NO conflict finding marker for this episode, no live fix agent, headRefOid unchanged since the finding. Action: sweep. Assert (fails tod…

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
