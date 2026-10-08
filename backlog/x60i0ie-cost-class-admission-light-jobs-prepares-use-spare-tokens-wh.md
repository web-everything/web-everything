---
kind: story
size: 8
status: open
scope: ["we:scripts/lib/cost-admission.mjs", "we:scripts/lib/cost-admission-facts.mjs", "we:scripts/lib/__tests__/cost-admission.test.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/__tests__/tick-core-cost-admission.test.mjs", "we:scripts/conveyor/build-dispatch-policy.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:skills-src/conveyor/__tests__/build-dispatch-cost-admission.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Cost-class admission: light jobs (prepares) use spare tokens while heavy caps are full

Classify dispatched job kinds heavy (runs local tests/builds: build, fix, ci-heal) vs light (no local tests: prepare family, task-agreement refresh, design/prep passes, tool-free review jurors, coroner samples). One pure rule (we:scripts/lib/cost-admission.mjs) over plain facts (cpu idle, heavy/light in flight, Claude USD today from the OTel collector, codex quota) + declared settings (we:scripts/dispatch-settings.json costAdmission; mode off = today's behaviour). Heavy stays under its caps and CPU guard; light is admitted under its own cap, a gentle CPU floor and a daily token budget, even when heavy caps are full. Wired into tick-core (prepare spawns skip load-cap/queue-cap when on) and the build daemon's prepare launch path; one report line per tick. Live 2026-10-08: 0 prepares launched in 76 build-daemon ticks (landing freeze 19 open PRs > 12, hard 2-prepare cap, prepare CPU floor 20% stricter than fix 8%).

## Done when

1. **Executable** — `npm run test:unit` over the three cost-admission test files in scope passes; with the rule ON, a replay of the 2026-10-08 picture (open-PR freeze + CPU idle below the heavy floors) launches item prepares, and with it OFF nothing changes.
2. **Live** — on the build daemon with `WE_COST_ADMISSION=on`, prepares are launched while builds are held by host-load / the open-PR freeze, and the tick log carries one `cost-admission …` line per tick.

Must: on any unreadable fact (host sample, Claude spend, settings file) the light rule fails OPEN to its own gates and never loosens a heavy gate; an unknown job kind is HEAVY.
Must: the kill switch and the global freeze label still hold light work; only the open-PR-count freeze is skipped (`lightOpenPrFreeze`, default `skip`).

## Edge cases this change must handle

1. **Untrusted text** — n/a: the rule reads numbers and fixed enums only; settings values are validated against enums/ranges and an invalid value falls to the next source, never to `on`.
2. **Truncated reads** — the collector day file is parsed line by line; a torn line is skipped; no cost record for the day reads as `null` (unknown), never `$0`.
3. **Shared state files** — read-only: we:scripts/dispatch-settings.json, the OTel collector day files and the host-sample cache are only read.
4. **Fail closed** — heavy gates are unchanged; light refuses on budget, light cap, light CPU floor and free memory; an unreadable meter admits (fails open) so a broken sampler cannot stop work the operator asked for.
5. **Identity scoping** — n/a: one host, one operator; the spend is the operator's own Claude account for the ET day.
6. **State over time** — Claude spend is cached 60 s; the ET day spans two UTC collector files and both are read.
7. **Who wrote it** — n/a: no authored content is trusted; the collector writes the cost records, the daemon only sums them.
