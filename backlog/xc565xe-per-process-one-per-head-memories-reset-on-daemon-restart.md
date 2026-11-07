---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/accept-carry-sweep.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# per-process one-per-head memories reset on daemon restart

Flow-sim gap E-G7, class K7 (unserialized duplicate actors). Failing input: overlap-exempt stale-base rebase or idle restack already dispatched once for a PR head in this daemon process' 'daemon restart (self-sync restartOntoNewCode, crash, launchd) Cited: we:scripts/conveyor/reconcile-fix-dispatch.mjs:2558-2560, we:scripts/conveyor/accept-carry-sweep.mjs:33-36. Soak-break sketch: a second exempt rebase / restack on the same head after every restart (acts twice).

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
