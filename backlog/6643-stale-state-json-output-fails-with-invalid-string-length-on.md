---
bornAs: xj0k40d
kind: story
size: 3
status: open
scope: ["we:scripts/operations/stale-state-io.mjs", "we:scripts/operations/stale-state.mjs", "we:scripts/operations/run.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# stale-state json output fails with 'Invalid string length' on main (health-watch staleState probe broken)

Live 2026-10-20: we:scripts/operations/run.mjs stale-state with the json flag, on plain origin/main and in the health-watch clone, stops step-refused with error 'Invalid string length'. The reader itself completes in-process; serializing its output (records incl. session-run effects and raw lane objects) exceeds V8's max string length. health-watch probeStaleState shells exactly this, so its staleState probe (stale-claim smell) likely fails every tick. Fix: bound the record payload (summarize session-run effects and lane objects), add a size regression test, prove live that the json stale-state read returns a verdict.

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
