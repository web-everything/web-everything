---
bornAs: x01yja3
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/stuck-pr-watch-core.mjs", "we:scripts/conveyor/health-smells/pr-stage-stall.mjs", "we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Stuck-PR watch and pr-stage-stall count an approved PR held only by red-team:pending/blocked as stuck in stag…

Flow-sim gap R6c-G3, class K9 (divergent predicates for one state). Failing input: PR with review:accepted (or ready-to-merge), mergeable MERGEABLE, red-team:pending (or red-team:blocked) on the head, no labeled/commented/committed event for 30 minutes (red team run in progress or awaiting operator), no live review-/fix- session. stuck-pr-watch sweep or health-watch pr-stage-stall evaluation Cited: we:scripts/conveyor/stuck-pr-watch-core.mjs:125-131, we:scripts/conveyor/stuck-pr-watch-core.mjs:147-149, we:scripts/conveyor/stuck-pr-watch-core.mjs:79-84, we:scripts/conveyor/health-smells/pr-stage-stall.mjs:78-85, we:scripts/lib/drain-queue-safety.mjs:446-450. Soak-break sketch: Fixture: 3 open PRs, labels review:accepted + red-team:pending, MERGEABLE, updatedAt 40 min old, no agents. Action: evaluateStuckPr on each and pr-stage-stall.evaluate on the set. Assertion (fails today): stuck is false with a reason naming the gate hold, and…

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
