---
kind: story
size: 3
priority: high
status: resolved
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/lib/builder-launch-policy.mjs"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Builder daemon: launch up to the free slots per tick (builder.maxLaunchesPerTick)

we:skills-src/conveyor/build-dispatch-daemon.mjs launches at most one item per tick (78b serialisation; #4658 alternates builds and prepares on that one slot), so with several free prepare/build slots launches trickle one per tick. Launch up to the free slots per tick in the existing priority order, each launch still passing every admission check, same-tick launches never sharing an item or scope, one failure never aborting the others. Bound by setting builder.maxLaunchesPerTick resolved through the policy cascade (standard default free-slots, platform preference, tool override, env); 1 = old behaviour.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:skills-src/conveyor/__tests__/build-dispatch-multi-launch.test.mjs we:scripts/lib/__tests__/builder-launch-policy.test.mjs` fails before (one launch per tick) and passes after: N free slots → N launches; same-tick scope overlap → one; a throwing claim/dispatch never aborts the others; `maxLaunchesPerTick: 1` = the old one-launch behaviour.
- [A2] **Must (on error)** — every launch still passes every existing admission gate (clone-fresh, host load / cost admission, open-PR cap, freeze, wip-cap, scope); a refused or throwing launch releases its claim and the tick continues.
- [A3] **Must (cascade)** — `builder.maxLaunchesPerTick` resolves standard `free-slots` → platform `we:scripts/lib/delivery-platform-preferences.json#builder` → tool `we:scripts/settings/*.json#builder` → env `WE_BUILDER_MAX_LAUNCHES_PER_TICK`; the daemon logs the effective value and its layer at start and on every tick (`launchPolicy`).
- [A4] **Live proof** — a live tick with 2+ launches (`dispatched` + `prepare.launched`) and no claim or overlap conflict.

## Non-goals

- [N1] Does not raise any slot cap (`maxConcurrentBuilds`, the prepare light cap); it only stops one-launch-per-tick from wasting slots that are already free.
- [N2] Does not create `we:scripts/lib/delivery-platform-preferences.json` (PR #4708 adds it); a missing file is read as "platform layer not set".

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the env/settings value is validated (integer 1–100 or `free-slots`); anything else is ignored and reported in `invalid`.
2. **Truncated reads** — an unparseable platform file is reported and the next layer down answers; never throws.
3. **Shared state files** — each launch takes its own claim and leases its own lane (x87v3ed); same-tick launches are checked against each other by card and scope.
4. **Fail closed** — a policy without the field keeps the 78b bound of 1; a launch that throws releases its claim.
5. **Identity scoping** — n/a: no identity input; claims keep their existing owner.
6. **State over time** — earlier ticks' still-starting launches count against the bound, so 1 stays exactly the old behaviour.
7. **Who wrote it** — the tick JSON names the layer (`launchPolicy.source`) that set the bound.
