---
kind: story
size: 1
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/preview.mjs", "we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs", "we:scripts/conveyor/soak/breaks/overlay-admission-repair-pin.mjs", "we:scripts/conveyor/soak/breaks/overlay-admission-repair-pin.soak.test.mjs"]
dateOpened: "2026-10-22"
tags: []
---

# Prevention: pin current-tip overlay admission coverage

PR #5809's security/fail-open-admission finding identified a registration check that accepted a carried ref solely because the rebuild planner could retain its old head. Registration must distinguish the candidate's current tip from a recovery pin. The repair adds the guard and regression cases; this card remains open until the launcher records verification evidence.

## Acceptance

- [A1] **Executable** — `we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs` test `refuses re-registering a carried ref whose conflicting tip is only applied as a pin without an operator override` must prove the candidate is pinned, refuse ordinary registration without a rebuild, and preserve authenticated override registration with conflict provenance. Verify it fails against the pre-fix source and passes with the repair.
- [A2] Preserve `admits M0/A0/M1/A1/R repair through the full plan with edge resolution off and no override` in the same file: a candidate applied at its own tip still registers when it unlocks the full stack.
- [A3] Run `we:scripts/conveyor/soak/breaks/overlay-admission-repair-pin.soak.test.mjs`, whose scenario removes a carried registration before re-adding its conflicting tip. Record the `pinned-candidate-admitted` failure before the fix and its absence after the fix. Retain the existing repair and prototype-name dedupe assertions.

## Non-goals

- [N1] Rebuild pinning, retry budgets and credential policy remain governed by their existing contracts.

## Edge cases

- A removed registry entry can still be carried by the running HEAD.
- Existing overlays may remain pinned while a new candidate applies at its current tip.
- A failed planner, a dropped candidate or a lost established overlay cannot authorize admission.
- A confirmed conflict can pass only through the existing authenticated operator override; missing conflict evidence fails closed.

## Proof status

The pre-fix unit-test attempt for `we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs` was deferred by heavy admission (exit 75, host load 4.81 per core versus a limit of 4). No test executed. Red proof, post-fix verification and soak proof remain owed to the launcher; no green verdict is claimed.
