# PR read inventory — shared-context wiring

Source inspection for the per-head snapshot change. This is a list of raw PR reads,
not evidence that each one is redundant or safe to cache. No live API traffic was
sampled during this edit. Guard reads must not be converted to contextual reads.

## Offenders addressed

| Reader / instruction | Bypass and change |
| --- | --- |
| `scripts/operations/review-pr-io.mjs` | Live view seeds the context; jurors reuse it. |
| `scripts/review-detail.mjs` | Pinned reads reuse context; unpinned reads stay live and seed it. |
| `scripts/conveyor/fix-context-pack.mjs` | Fix view + complete thread and CI files use the planned-head context; checks stay live. |
| `scripts/conveyor/fix-round-history.mjs` | Commit/ref context is shared; repeated-finding authority comments stay live. |
| `scripts/operations/review-pr.mjs` | Tool-bearing jurors had no shared-context port. Concrete PR mandates now include the absolute script path, repo, PR and examined SHA. Generic mandate guards stay unchanged. |
| `skills-src/conveyor/fix-agent-brief.md` | Steps 2 and 2a explicitly requested duplicate `gh pr view title,body,comments`; both now use the pinned context CLI. |
| `scripts/conveyor/reconcile-fix-dispatch.mjs`, `scripts/operations/ci-heal-pr-dispatch.mjs` | Packs lacked the planned SHA; dispatch now forwards it, including round-history callers. |

The existing immutable-only `review-pr-snapshot.mjs` adapter performed a live metadata
probe on every read, even on hits. It did not cache mutable body/comments and could
not give a contextual reader a zero-gh hit. The new explicitly pinned context port
uses the existing TTL cascade and shared directory, with a separate contextual schema.

`review-facts.mjs` only substitutes healthy webhook facts for dispatch/label discovery;
its unavailable/unhealthy/missing-row path intentionally falls back live. It supplies
neither the jurors' contextual body nor a complete thread. Its post-check head
revalidation stays live. `review-core.mjs` itself does not shell out.

`pr-snapshot.mjs` is the open-PR discovery cache, not a write authority source.
`pr-list-paged.mjs` hydrates heavy fields per PR; `gh-metered-reads.mjs` meters queries
without making them cache hits. `gh-rest-read.mjs` conditional GETs still launch gh
on a 304. `pr-view-transport.mjs` defines the alternate CI-produced evidence transport;
its provenance/subject guards remain intact. `gh-spend.mjs` accounts calls; it is not
a read adapter.

## Other raw read sites found across scripts

These remain raw reads. Many are live state, label, merge, completeness, revalidation,
write-idempotency or provenance checks, and must remain live. Others are offline
analysis or discovery consumers outside the juror/fixer context path; this inventory
does not claim those have been rerouted. The original scan included literal PR-view,
pulls and issue-comment reads; argv factories can span several lines.

- `scripts/check-review-gate.mjs` (scan lines 69)
- `scripts/conveyor/advisory-label-sweep.mjs` (scan lines 111)
- `scripts/conveyor/await-verify-pass.mjs` (scan lines 685)
- `scripts/conveyor/ci-heal-escalation-mark.mjs` (scan lines 432, 499)
- `scripts/conveyor/ci-heal-mark.mjs` (scan lines 451, 480)
- `scripts/conveyor/ci-heal-owed.mjs` (scan lines 183)
- `scripts/conveyor/ci-red-recovery-watch.mjs` (scan lines 704, 1122)
- `scripts/conveyor/convert-advisory-dispatch.mjs` (scan lines 612)
- `scripts/conveyor/draft-promotion-loop.mjs` (scan lines 64)
- `scripts/conveyor/fix-procedure.mjs` (scan lines 658, 748)
- `scripts/conveyor/fix-push-ci.mjs` (scan lines 63)
- `scripts/conveyor/fix-resume.mjs` (scan lines 317)
- `scripts/conveyor/fixer-stuck-reclaim.mjs` (scan lines 185)
- `scripts/conveyor/health-watch.mjs` (scan lines 773)
- `scripts/conveyor/load-flake-reverify.mjs` (scan lines 321)
- `scripts/conveyor/missing-run-push.mjs` (scan lines 55)
- `scripts/conveyor/open-pr-fetch.mjs` (scan lines 100)
- `scripts/conveyor/parked-pr-conflict-watch.mjs` (scan lines 1061, 1130, 1159)
- `scripts/conveyor/pr-comments-complete.mjs` (scan lines 33)
- `scripts/conveyor/pr-comments-list.mjs` (scan lines 61)
- `scripts/conveyor/pr-watch.mjs` (scan lines 404)
- `scripts/conveyor/prep-review-io.mjs` (scan lines 44, 53)
- `scripts/conveyor/reconcile-fix-dispatch.mjs` (scan lines 652, 665, 667, 1768, 2279)
- `scripts/conveyor/reconcile-pass.mjs` (scan lines 1172, 1817, 1821, 1863, 1896)
- `scripts/conveyor/review-referral-hold.mjs` (scan lines 359)
- `scripts/conveyor/review-stack-base.mjs` (scan lines 364, 381)
- `scripts/conveyor/ruling-resolved-stand-down.mjs` (scan lines 108)
- `scripts/conveyor/session-reaper.mjs` (scan lines 820, 1098, 1536)
- `scripts/conveyor/session-verdicts-io.mjs` (scan lines 65)
- `scripts/conveyor/soak/breaks/build-dispatch-graphql-exhausted.mjs` (scan lines 60)
- `scripts/conveyor/soak/breaks/capped-compare-scope-never-trusted.mjs` (scan lines 56)
- `scripts/conveyor/soak/breaks/compare-without-files-never-trusted.mjs` (scan lines 29)
- `scripts/conveyor/stale-base-refresh.mjs` (scan lines 131, 199)
- `scripts/conveyor/stand-down-answer.mjs` (scan lines 26)
- `scripts/conveyor/supersede-watch.mjs` (scan lines 81)
- `scripts/conveyor/tick-core.mjs` (scan lines 2173)
- `scripts/daemon-overlay.mjs` (scan lines 139)
- `scripts/fetch-parked.mjs` (scan lines 376)
- `scripts/held-cards-io.mjs` (scan lines 191)
- `scripts/lane-resume.mjs` (scan lines 481)
- `scripts/lib/agy-shadow-trial-report.mjs` (scan lines 193)
- `scripts/lib/approved-human-surface-hold.mjs` (scan lines 28)
- `scripts/lib/daemon-edge.mjs` (scan lines 574)
- `scripts/lib/daemon-overlays.mjs` (scan lines 423)
- `scripts/lib/daemon-rebuild/edge-fetch.mjs` (scan lines 116)
- `scripts/lib/drain-merge-strategy.mjs` (scan lines 295, 297, 540)
- `scripts/lib/drain-queue-safety.mjs` (scan lines 57)
- `scripts/lib/enqueue-on-event.mjs` (scan lines 283)
- `scripts/lib/fix-facts.mjs` (scan lines 86)
- `scripts/lib/forge-land-provider.mjs` (scan lines 122)
- `scripts/lib/merge-queue-adaptive-batching.mjs` (scan lines 494)
- `scripts/lib/merge-queue-enqueue.mjs` (scan lines 274)
- `scripts/lib/merge-queue-hook.mjs` (scan lines 187)
- `scripts/lib/model-probation.mjs` (scan lines 424)
- `scripts/lib/pr-facts.mjs` (scan lines 393, 397)
- `scripts/lib/pr-list-paged.mjs` (scan lines 155)
- `scripts/lib/pr-state-io.mjs` (scan lines 92)
- `scripts/lib/referral-card-readable.mjs` (scan lines 28)
- `scripts/lib/renamed-pr-refresh.mjs` (scan lines 131)
- `scripts/lib/review-ci-gate-io.mjs` (scan lines 13, 15)
- `scripts/lib/review-comment-edit.mjs` (scan lines 15)
- `scripts/lib/review-label-provider.mjs` (scan lines 90, 91, 128, 133, 138)
- `scripts/lib/review-log-claims.mjs` (scan lines 518)
- `scripts/lib/review-pr-snapshot.mjs` (scan lines 38)
- `scripts/lib/review-precedents-io.mjs` (scan lines 174)
- `scripts/merge-ai-prs.mjs` (scan lines 770, 862, 2153, 4577, 4623, 4739, 4754, 5064, 5636, 5766, 6022, 6032)
- `scripts/merge-gate-check.mjs` (scan lines 169)
- `scripts/operations/action-ground-truth.mjs` (scan lines 75)
- `scripts/operations/card-batch-io.mjs` (scan lines 190)
- `scripts/operations/card-batch-seal-io.mjs` (scan lines 85, 235)
- `scripts/operations/ci-heal-pr-dispatch.mjs` (scan lines 685)
- `scripts/operations/clear-stuck-session-io.mjs` (scan lines 182)
- `scripts/operations/close-items-io.mjs` (scan lines 18)
- `scripts/operations/coroner-extract.mjs` (scan lines 536)
- `scripts/operations/coroner-false-findings.mjs` (scan lines 99)
- `scripts/operations/coroner-rounds.mjs` (scan lines 408, 412, 414)
- `scripts/operations/delivery-metrics.mjs` (scan lines 213, 217)
- `scripts/operations/dispatch-lane-io.mjs` (scan lines 3435)
- `scripts/operations/extend-rounds-io.mjs` (scan lines 13)
- `scripts/operations/fix-run.mjs` (scan lines 397, 582)
- `scripts/operations/free-scope-io.mjs` (scan lines 112)
- `scripts/operations/item-activity-io.mjs` (scan lines 21)
- `scripts/operations/land-advance-io.mjs` (scan lines 103, 186)
- `scripts/operations/land-human-only-io.mjs` (scan lines 124, 188)
- `scripts/operations/needs-you-feed.mjs` (scan lines 182)
- `scripts/operations/operator-controls-io.mjs` (scan lines 39)
- `scripts/operations/operator-queue.mjs` (scan lines 543, 726, 728)
- `scripts/operations/operator-why-io.mjs` (scan lines 51)
- `scripts/operations/perf-velocity-io.mjs` (scan lines 178)
- `scripts/operations/pr-status-io.mjs` (scan lines 39, 162)
- `scripts/operations/probation-heal-run.mjs` (scan lines 118, 474)
- `scripts/operations/promote-draft-pr-dispatch.mjs` (scan lines 147, 195)
- `scripts/operations/record-referral-ruling-io.mjs` (scan lines 39, 203)
- `scripts/operations/red-team-gate-apply.mjs` (scan lines 241, 248)
- `scripts/operations/review-extra-seats.mjs` (scan lines 1755)
- `scripts/operations/review-job.mjs` (scan lines 295)
- `scripts/operations/review-loop-cli.mjs` (scan lines 480, 518)
- `scripts/operations/route-pr-outcome-io.mjs` (scan lines 57)
- `scripts/operator/dispatch.mjs` (scan lines 428)
- `scripts/pr-body-edit.mjs` (scan lines 104, 170)
- `scripts/pr-state.mjs` (scan lines 98)
- `scripts/produce-pr-view.mjs` (scan lines 52)
- `scripts/prune-landed-lanes.mjs` (scan lines 233)
- `scripts/readiness/conveyor-instrument.mjs` (scan lines 504)
- `scripts/review-corpus/mine-review-corpus.mjs` (scan lines 651)
- `scripts/review-runner.mjs` (scan lines 137)
- `scripts/soak-replay-gate-cli.mjs` (scan lines 89)
