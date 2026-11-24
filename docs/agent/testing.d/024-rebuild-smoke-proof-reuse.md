## Rebuild smoke proof reuse

Rebuilds retain up to five complete passing smoke proofs in the existing per-clone rebuild state.
Keys bind clone kind, Git tree, lockfile, Node version and the running smoke harness hash.
`rebuildSmoke.reuseEnabled` (true) and `rebuildSmoke.reuseHours` (12) resolve through the
standard → platform → `scripts/settings/rebuild-smoke.json` → env cascade; env overrides are
`WE_REBUILD_SMOKE_REUSE_ENABLED=0|1` and `WE_REBUILD_SMOKE_REUSE_HOURS`. Log each leaf's source.
On reuse, materialize the candidate and skip only table rows declaring `kind: code`; every `env`
row runs again, including lane lease/release, daemon boot and tree cleanliness. A failed env
check refuses adoption. Reused passes never refresh the original proof timestamp; missing rows,
failures, disabled gates, busy-pool skips and other partial runs never establish a proof.
After a candidate failure, set-aside, plain-main, confirmation and last-good smokes run fresh
code checks, without cached proofs or unchanged-code skips. Even a fallback already running
must pass a fresh comparison before the rebuild blames and removes an overlay.
Probe identical-content commits, changed trees, expiry, disabled reuse, failure and partial
results through the real rebuild fixture, plus actual check selection through `runLiveSmoke`.
Run these suites through the host heavy-admission queue.

