---
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/forge-exec-sweep.mjs", "we:scripts/readiness/__tests__/forge-exec-sweep.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Forge sweeper: reap abandoned prepared/running/receipt records with owner-gone proof

we:scripts/readiness/forge-exec-sweep.mjs only expires .telemetry and .consumed receipts. Abandoned .prepared/.running/.receipt records keep their run dirs alive via hasLiveRecord and persist forever; the 7-day abandoned-reservation recovery is only partly mirrored. Add an age-bounded reaper with owner-gone proof (R951c, reinforce-later from the sweeper PR).

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
