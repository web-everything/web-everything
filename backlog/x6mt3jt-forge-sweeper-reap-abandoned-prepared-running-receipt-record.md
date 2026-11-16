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

- [A1] **Executable** — n/a: reinforce-later card; handled when the story is built (see digest).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: reinforce-later card; handled when the story is built (see digest).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reinforce-later card; handled when the story is built (see digest).
2. **Truncated reads** — n/a: reinforce-later card; handled when the story is built (see digest).
3. **Shared state files** — n/a: reinforce-later card; handled when the story is built (see digest).
4. **Fail closed** — n/a: reinforce-later card; handled when the story is built (see digest).
5. **Identity scoping** — n/a: reinforce-later card; handled when the story is built (see digest).
6. **State over time** — n/a: reinforce-later card; handled when the story is built (see digest).
7. **Who wrote it** — n/a: reinforce-later card; handled when the story is built (see digest).
