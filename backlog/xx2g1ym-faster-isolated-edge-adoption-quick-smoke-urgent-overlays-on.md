---
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/daemon-overlay.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Faster, isolated edge adoption: quick smoke, urgent overlays, one bad overlay never blocks the rest

Operator ruling 2026-10-03. Edge overlays took 10-30 min to load that day instead of ~2: rebuilds wait for a moment when no daemon is mid-pass (tick-in-progress / concurrent-mover), the live smoke takes ~70 s and 100 s+ under load (reconcile-dry-run 25 s, dispatch-dry-run 40 s; health-watch clone-stale flags these), and all overlays are merged and smoked together so one bad overlay holds back the others. Fix in we:scripts/lib/daemon-rebuild.mjs and the smoke checks: trim or cache the dry-run smokes; an urgent-overlay flag that asks daemons to pause at their next pass boundary instead of waiting for a quiet moment; when a combined candidate fails, retry each overlay alone and adopt the ones that pass. Done when: tests cover isolate-on-failure and the urgent flag; live: an overlay loads in under 3 min on a busy daemon clone, with timings before/after.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
