---
bornAs: x3y6aek
kind: story
size: 5
parent: "3443"
status: open
blockedBy: ["3854", "3891"]
scope: ["we:scripts/operations/land-advance-items.mjs", "we:scripts/operations/land-advance-items-io.mjs", "we:scripts/operations/land-advance-gate.mjs", "we:scripts/land-advance-hook.mjs", "we:scripts/operations/__tests__/land-advance-hook.test.mjs", "we:scripts/operations/__tests__/land-advance.test.mjs"]
dateOpened: "2026-09-21"
tags: []
---

# Graduate #3720's remainder -- item-pull, single-flight lease, canonical pause/opt-in gate, Stop hook (we:scripts/operations/land-advance-items.mjs, we:scripts/operations/land-advance-items-io.mjs, we:scripts/operations/land-advance-gate.mjs, we:scripts/land-advance-hook.mjs) -- from lane/mechanical-dispatcher to main

Ports the rest of #3720 beyond the six-slice land-advance core (#3853/3854/3855/3856 plus the already-landed #3851/3852): we:scripts/operations/land-advance-items.mjs (17 lines, pure budget/priority split), we:scripts/operations/land-advance-items-io.mjs (69, reads #3383's Priority order plus dispatch-plan --queue-file, queues into the canonical we:.conveyor/queue.json), we:scripts/operations/land-advance-gate.mjs (68, the file-locks single-flight lease and the canonical-checkout pause/opt-in gate) and we:scripts/land-advance-hook.mjs (40, the Stop-hook entry that launches we:scripts/operations/land-advance-cli.mjs --mode=dispatch detached), with we:scripts/operations/__tests__/land-advance-items-io.test.mjs and we:scripts/operations/__tests__/land-advance-hook.test.mjs. Dispatch stays plan-only until the operator both writes the durable opt-in file and rules the accompanying decision card 3864 -- the code may graduate before that ruling, since the gate defaults to plan-only.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/land-advance-items-io.test.mjs we:scripts/operations/__tests__/land-advance-hook.test.mjs` passes ON `main` after the port, and `git diff origin/main...origin/lane/mechanical-dispatcher -- we:scripts/operations/land-advance-items.mjs we:scripts/operations/land-advance-items-io.mjs we:scripts/operations/land-advance-gate.mjs we:scripts/land-advance-hook.mjs we:scripts/operations/__tests__/land-advance-items-io.test.mjs we:scripts/operations/__tests__/land-advance-hook.test.mjs` reports nothing. Once #3856 is also on `main`, `we:scripts/operations/land-advance-cli.mjs --mode=plan` runs from a lane clone and prints a plan without dispatching anything (the gate's safe default) — see the port notes below for why that file's own diff, once #3856 is built fresh from the current branch tip, will carry the import this slice provides.
2. `npm run check:standards` reports 0 errors.
3. Landed as its own PR through the normal lane → `we:scripts/verify-lane.mjs` → `we:scripts/operations/run.mjs open-pr --mode=land` pipeline, never a direct push, and never before the decision card #3864 below is filed (ruling is not required to land the code — the gate defaults to plan-only — but the card must exist on `main` first so the operator can find it).

## Order and port notes

- **CORRECTION to the source job brief's assumption ("downstream of #3856"):** none of this slice's four files import anything from #3853/#3854/#3855/#3856. `we:scripts/operations/land-advance-gate.mjs`, `we:scripts/operations/land-advance-items.mjs` and `we:scripts/operations/land-advance-items-io.mjs` import only modules already on `main` (`we:scripts/readiness/file-locks.mjs`, `we:scripts/readiness/dispatch-pause.mjs`, `we:scripts/conveyor/resolve-runner-checkout.mjs`, `we:scripts/bootstrap-session.mjs`, `we:scripts/lib/constellation-repos.mjs`, `we:scripts/conveyor/queue-store.mjs`, `we:scripts/conveyor/reconcile-core.mjs` — confirmed present by name); `we:scripts/land-advance-hook.mjs` imports only its sibling `we:scripts/operations/land-advance-gate.mjs`. The real dependency runs the OTHER way: the branch's current `we:scripts/operations/land-advance-cli.mjs` (in #3856's scope) now imports `we:scripts/operations/land-advance-gate.mjs` (this slice), and the branch's `we:scripts/operations/__tests__/land-advance.test.mjs` (in #3854's scope) now imports `we:scripts/operations/land-advance-items-io.mjs` (this slice) for two new describe blocks (`priorityQueue`, `reconcileHolds`). Neither #3854 nor #3856 has been re-scoped for this yet as of this filing — flagged here rather than edited there, since re-scoping those cards is outside this filing's mandate.
- **Real, currently-unfiled prerequisite, not guessed away:** `we:scripts/operations/land-advance-items-io.mjs` imports `parsePriorityRows` from `we:scripts/lib/prototype-tracker-compact.mjs`. That module — and the `we:scripts/lib/prototype-tracker-compact-io.mjs` / `we:scripts/lib/priority-order.mjs` / `we:scripts/lib/tracker-page-hash.mjs` family it in turn depends on — does not exist on `main` in any form (`main` has a differently-shaped `we:scripts/lib/prototype-tracker-data.mjs` / `we:scripts/lib/prototype-tracker-render.mjs` pair instead) and no backlog card graduates it. This slice cannot actually build until that family is ported or `parsePriorityRows` is adapted onto main's `we:scripts/lib/prototype-tracker-data.mjs`. No `blockedBy` id is set for it because none exists yet; the next session that picks up this card should file that slice first (or fold the adaptation in here, once inspected, if it turns out small).
- The decision card #3864 (filed on `main` as part of this same PR, `parent: 3383`) rules the four open forks this slice's build ran with defaults on: canonical-checkout naming, items-per-call, opt-in file home, what "dispatch" means. `blockedBy` here points to it so the operator can find and rule it; the code itself is safe to land unruled (plan-only default).
- `TODO(#3807)`: the `os.loadavg()` capacity gate in `we:scripts/operations/land-advance.mjs` (#3854's scope, not this slice's) stays until #3807's `dispatch-budget` config lands.
- The `Stop` hook install (a `we:.claude/settings.json` snippet) and the operator's durable opt-in file (`we:.conveyor/land-advance-opt-in.json`) are operator actions, not part of this graduation.

## Step 0 re-plan (2026-09-22)

Dropped blocker #3864: it was ratified 2026-09-22, and its own Done-when needs this slice's tests on main, so waiting on it was circular. #3864 resolves when this slice and #3856 land. Added blockers #3854 (`we:scripts/operations/land-advance-items.mjs` moved there) and 3891 (`we:scripts/lib/prototype-tracker-compact.mjs`).

## Graduation import check

- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/land-advance-items-io.test.mjs` to #3856 — it imports a module #3856 owns.
- 2026-09-24: graduation-import-check moved `we:scripts/operations/__tests__/land-advance.test.mjs` here from #3854 — it imports a module this card owns.
