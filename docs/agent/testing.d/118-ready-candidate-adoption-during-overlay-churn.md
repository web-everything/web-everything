## Ready-candidate adoption during overlay churn

`rebuildClone` keeps phase waits in a non-enumerable `timing` record to preserve existing result
equality. The rebuild CLI explicitly serializes it for detached jobs; `daemon-rebuild-early-timing.test.mjs`
checks the legacy shape and runs the actual CLI subprocess to verify timing transfer into the job result.
Do not reconstruct CLI serialization in the test: removing the producer's timing serialization must fail it.
Adoption latency remains in adoption state.

`daemon-rebuild-ready.test.mjs` exercises adoption with real Git ancestry: newly registered
refs and descendant advances remain pending after adoption, and the next adopt-only tick
must return `needs-build` with a different plan. `ready-candidate-adopted-partial` is an
open-kind rebuild alert emitted after successful adoption only when pending refs exist.
A candidate containing a removed ref is refused as `overlay-no-longer-wanted`, even when
another overlay contains its tip; `pr-merged`/`in-main` removals retain their existing wanted
handling. Each wanted tip must equal or descend from the candidate's tip. Preserve the independent
live-applied omission, build-provenance, smoke, forced-record and canonical-audit gates.
Preserve `overlaysBefore` as a veto for omitted live tips: the regression for a live overlay
retired during planning must reject its omission and preserve HEAD.
Run this file and `daemon-rebuild-events.test.mjs` through heavy admission. This adoption
rule does not reset overlay main-sync parking or add retries for parked overlays.


