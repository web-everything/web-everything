---
kind: story
size: 3
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/lib"]
dateOpened: "2026-10-25"
tags: []
---

# Heavy-admission: wall-clock cap per slot and process-group kill so a hung run is ended

R77 2026-10-24 19:12 ET: the heavy-admission run uses a shell, so a timeout cannot reliably kill descendants (combined-tree tests in prototype-load #5884 inherit this). 2026-10-20 coroner: lane-21 held a heavy slot 53+ min and lane-8 43-49+ min while others waited; bun-trial vitest runs hung 8h42m and were stopped by hand; load peaked at 91 on 12 cores. Want: every heavy slot has a wall-clock cap (default 20 min, per kind); on expiry the recorded process group is killed by pid and the slot freed with a needs-you line; runs with no slot are refused. Prove: a deliberately hung vitest in a throwaway lane ends at the cap and the slot is reused.

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
