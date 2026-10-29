---
bornAs: xsewwno
kind: story
size: 3
status: open
scope: ["we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Fix daemon must not count lane-acquire contention as a fix attempt

we:scripts/operations/fix-run.mjs runs lane-pool acquire --wait-ms and a 'no lane within Nms (lock contention)' or exit-75 failure is counted as a fix attempt (hit #6017, #6023, #6035, #6046 on 2026-10-28). Treat lane-pool acquire exit 75 and lock-contention failures as environmental: retry with backoff inside the run, never increment the attempt counter. Prove on a live contended acquire.

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
