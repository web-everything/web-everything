---
bornAs: xak56ki
kind: story
size: 2
tier: pinned
status: resolved
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/lib/daemon-clone-registry.mjs"]
dateOpened: "2026-09-29"
dateResolved: "2026-10-12"
graduatedTo: 10fedba67afc9550fb9a6592282603117284c0c2
tags: []
---

# probation-build-run never writes to the checkout it runs from (claims only inside its own lane)

2026-09-29 ~7:35 PM ET: an operator run of we:scripts/operations/probation-build-run.mjs from the build daemon clone (~/workspace/wev-control) for #3809 wrote the claim (status: active, dateStarted) into the CLONE itself, not into its lane — because the script derives WE_ROOT from its own location and claims there. The dirty clone then blocked every builder overlay/rebuild (daemon-load-overlay: dirty), which blocked the stale-prepare-claim fix (#3024). MVP: all item mutations (claim, resolve, release) run with cwd = the acquired lane, never WE_ROOT; the script refuses to start when WE_ROOT is a registered daemon clone unless it only reads from it (we:scripts/lib/daemon-clone-registry.mjs); on any early failure nothing outside the lane is touched. Test: a run whose repo root is a daemon clone leaves the clone clean on both success and failure. Proof: replay the #3809 launch from the clone → clone stays clean.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
