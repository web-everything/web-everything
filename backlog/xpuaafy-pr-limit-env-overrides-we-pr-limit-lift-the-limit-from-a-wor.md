---
kind: story
size: 3
status: active
scaffoldedBy: "fix-4791"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/operations/session-role.mjs", "we:scripts/lib/pr-limit.mjs", "we:scripts/conveyor/health-watch.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# pr-limit env overrides (WE_PR_LIMIT_*) lift the limit from a worker's own command

PR 4791 gated the `allow` and `off` verbs. The env overrides still lift the limit with no gate: `WE_PR_LIMIT_OFF=1`, the per-repo `WE_PR_LIMIT_<REPO>` cap, `WE_PR_LIMIT_EXCLUDE_CARD_ONLY` / `WE_PR_LIMIT_EXCLUDE_STACKED_AWAITING_BASE`, and `WE_PR_LIMIT_STATE_FILE` (a forged store). A worker can prefix its own `pr-land` with any of them.

They cannot be gated on the session role inside `we:scripts/lib/pr-limit.mjs`: `markWorkerEnv` copies the operator's env into every worker, so an operator-set value and a worker-set one look the same, and a role gate would split the dispatcher (honours the override, dispatches) from the worker's `pr-land` (ignores it, refuses at open). PR 4791 tried that gate for `WE_PR_LIMIT_OFF` and reverted it for this reason.

Fix at the spawn site: strip `WE_PR_LIMIT_*` from the worker env (and the `--settings` env) in `we:scripts/operations/session-role.mjs` `markWorkerEnv` / `workerMarkerSettingsEnv`, carry the operator's effective values through the gated store instead, and only then make the lib ignore the env overrides in a worker. Also: `probePrLimit` in `we:scripts/conveyor/health-watch.mjs` repeats the `WE_PR_LIMIT_OFF` check instead of calling `isGlobalOffLive`.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/pr-limit.test.mjs`: with `WE_CONVEYOR_WORKER=1` and a worker-set `WE_PR_LIMIT_WE=999` / `WE_PR_LIMIT_OFF=1`, `pr-land`'s limit decision stays refused over the default cap; an operator-set value reaches the worker through the sanctioned path and is honoured by both the dispatcher and the worker. Red before, green after.
- [A2] `markWorkerEnv` output carries no `WE_PR_LIMIT_*` key.
- [A3] `probePrLimit` calls `isGlobalOffLive`.

## Non-goals

- [N1] Making the limit unforgeable — a worker with a shell can still write the store directly; this only removes the env shortcuts.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the per-repo cap stays a finite number ≥ 0; anything else falls back to the default.
2. **Truncated reads** — n/a: env reads are whole.
3. **Shared state files** — the operator's values move into the store, written through the existing atomic writer and the `off` gate.
4. **Fail closed** — an unknown session role ignores every env override.
5. **Identity scoping** — the strip runs at every spawn site `markWorkerEnv` names.
6. **State over time** — an operator change reaches workers dispatched after it, through the store.
7. **Who wrote it** — only the gated store carries operator overrides into a worker.
