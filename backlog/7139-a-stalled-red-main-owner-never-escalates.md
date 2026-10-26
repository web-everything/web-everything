---
bornAs: x8i7xlz
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A stalled red-main owner never escalates

[held entry 302] (coroner-redmain 2026-10-14, held) A stalled red-main owner never escalates. Health-watch alerted once at 02:09 ET, then said "dispatched main-fix-62da75ed3 owns the fix, watch it land" for 4h34m. Meanwhile the owner PR #5269 had red CI, #5269/#5270/#5271 were refused fix-cap / no-lane, and the fix could not edge-load. Main stayed red 01:53–06:43 ET, and the operator acted only at the morning sweep. Fix idea: an owner counts only while it is moving: its PR opened within N min, its CI is not red, it is not refused by a cap or hold, and any re-run is in flight. Otherwise the owner state becomes owner-stalled with the reason. Re-notify through quiet hours when red time passes mainCiRed.escalateAfterMin (setting, default 60), then every 60 min, naming the stall reason and the one approval that would clear it (for example "approve a re-run of run X"). Evidence: health episode 2026-10-14-main-ci-red-main-62da75ed3-0609; health-watch.log 06:09Z–10:43Z; fix-dispatch-daemon.log 07:41Z–09:44Z (refused fix-cap / no-lane). Scope: we:scripts/conveyor/health-smells/main-ci-red.mjs, we:health-watch-core.mjs, we:health-smells-notify-list.mjs. Size 3.

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
