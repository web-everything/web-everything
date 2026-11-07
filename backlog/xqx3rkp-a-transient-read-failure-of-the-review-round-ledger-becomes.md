---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A transient read failure of the review-round ledger becomes a permanent round-cap hand-over to the operator

Flow-sim gap B-C5, class K5 (transient read failure becomes a permanent decision). Failing input: Labels: review:accepted. Trusted red-team result on HEAD with a confirmed `broken` finding; no gate marker. Round is well under the cap. gate runs while the verdict ledger read fails (gh throttle, network, malformed row). Cited: we:scripts/operations/review-pr-io.mjs:401-408, we:scripts/operations/red-team-gate-apply.mjs:161, we:scripts/lib/red-team-gate.mjs:390-435. Soak-break sketch: wrong-clear of the automatic send-back (fixer is not dispatched; PR parked for an operator ruling via record-red-team-ruling) caused by a transient failure, never reconsidered

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
