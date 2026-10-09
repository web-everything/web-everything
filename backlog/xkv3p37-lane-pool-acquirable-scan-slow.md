---
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# lane-pool list --acquirable blows its scan budget on a loaded host (~100 lanes), stalling every builder tick

On 2026-10-09 (load avg 17-19, 101 lanes) list --acquirable took 37s at best and otherwise waited 120s for the scan lock then exceeded its own 120s scan budget (failing at lane-37..89, i.e. slow throughout, not one hung git). That failure crashed dispatch-plan and every build-dispatch tick (13 tick-failed today); dispatch-plan/tick-core now fail soft to 0 free lanes (lane/dispatch-plan-tick-crash), but then nothing launches. It also dominates planTick (373-550s on failing ticks: lock wait + scan, retried). Fix upstream: make the acquirable scan cheap enough under load (parallel/bounded per-lane git probes, cached per-lane verdicts keyed on lane HEAD/index mtime, or a lease-registry-first answer that only git-probes candidate lanes), so it answers well inside budget at 100 lanes and load 20. Proof: before/after list --acquirable wall time on the live pool under load, and consecutive builder ticks with no free-lane-read warning.

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
