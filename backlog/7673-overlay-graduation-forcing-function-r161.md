---
bornAs: x4l6bn0
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Overlay graduation forcing function (R161)

MED priority hint. ## (held 2026-10-27 11:44 ET) Overlay graduation forcing function (R161) Track each registered overlay's age and its non-main line count. Past the limit (policy-cascade: about 3 days / 500 lines), auto-open small (≤300-line) graduation PRs off main for the uncovered pieces, using the drain-graduation inventory method. A daemon over the limit refuses new overlays except lane/main-fix-*. Live case: drain top 1026d carried about 8.4k non-main lines across 229 commits on 10-27. - Drain human-enqueue classification on the net diff (#5993 false positive): start when the drain unfreezes.

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
