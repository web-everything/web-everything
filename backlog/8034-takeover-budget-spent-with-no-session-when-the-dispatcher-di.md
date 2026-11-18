---
bornAs: xhvx49w
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-takeover.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# takeover budget spent with no session when the dispatcher dies between marker post and launch

Flow-sim gap E-G4, class K3 (one-shot step, no re-driver). Failing input: PR at round cap, planned.takeover set' 'daemon SIGKILL / host crash after postTakeover (:1580) and before spawn (:1598/:1662/:1678) Cited: we:scripts/conveyor/reconcile-fix-dispatch.mjs:1577-1586, we:scripts/conveyor/fix-takeover.mjs:228-258. Soak-break sketch: takeover counted but never ran; with budget 2 the PR may go to the operator after one real attempt. Self-sync restarts happen between ticks, so this needs a crash or kill mid-tick.

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
