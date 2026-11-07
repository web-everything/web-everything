---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/liveness-sweep-core.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/runner.mjs", "we:scripts/conveyor/review-round-tag.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# informative review-round:N label feeds a stuck-PR detector; missing or stale label blinds it

Flow-sim gap E-G9, class K15 (detector or report false negative). Failing input: PR at or past the round cap, head changed after last review, no live review/fix owner; review-round label missing (tagRound failure is swallowed) or older than the current count' 'liveness sweep Cited: we:scripts/conveyor/liveness-sweep-core.mjs:135-139, we:skills-src/conveyor/review-daemon.mjs:708, we:skills-src/conveyor/runner.mjs:480, we:scripts/conveyor/review-round-tag.mjs:37-43. Soak-break sketch: detector reads 0 and does not fire; PR waits unreported. Detector only, no state damage.

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
