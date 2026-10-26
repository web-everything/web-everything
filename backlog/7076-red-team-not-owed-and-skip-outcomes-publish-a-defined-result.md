---
bornAs: x3t4f0k
kind: story
size: 3
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/red-team-gate-apply.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team 'not owed' and skip outcomes publish a defined result instead of silence

Live 2026-10-24/25: #5759 red-team result not-owed at 06:43 ET never published and red-team:pending stays; #5910 clear removed 13:15Z on a new head, daemon says 'stored review does not owe a red team' every tick, red-team:clear never republished; the skip dedupe treats ANY row as clean (#5884: alert said a clean row exists while it was a confirmed break); #5890 (live on review via 1025b) reads REVIEW-pr rows in red-team-status/<pr>-<head>.json as red-team results and alerts 'red team resumed but its result comment is error'. Want: a not-owed outcome on a non-accepted or new head publishes clear or carries the prior clean result (or re-dispatches); only a clean verdict row satisfies the skip dedupe; settle only rows whose payload is a red-team run.

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
