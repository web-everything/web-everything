## Review CI fixture provenance

Gate fixtures that inject a complete head-scoped check/status read use
`scripts/lib/__tests__/helpers/complete-check-rows.mjs` to retain the array API
while attesting `rowsComplete` and `rowsHead`. Direct planner PR fixtures carry
these fields on the PR. Keep deliberately incomplete/wrong-head cases raw so
they continue exercising refusal. The review facts store contains completed check
runs only, without legacy statuses or pending runs; it cannot attest a complete
check read. Its gate tests inject the live fallback and assert its decision and
call cost rather than manufacturing completeness for the store.

`runReconcilePass` also hydrates short rollups without this provenance. Its injected
PR fixtures must carry both fields when modeling a complete read, including fixtures
shared with ruling tests and stand-down or stacked-PR soak replays. Leave missing or
incomplete evidence explicit when testing hydration and recovery; a green rollup alone
must still invoke the injected check reader.

Soak worlds enable the paged snapshot reader with a private `WE_PR_SNAPSHOT_DIR`
under each world's cleanup root. Vitest's flattened-list fallback cannot attest
check completeness. Replays that simulate a push must also model a complete read
on the new head before expecting a recovery review.
Scenario ticks run without the production daemon's sleep, so these worlds pin
`WE_PR_SNAPSHOT_TTL_MS=0` and `WE_PR_SNAPSHOT_STALE_OK_MS=0`. Each read still uses
the paged reader and validates completeness, but immediate follow-up ticks see
verdicts and pushes rather than cached pending labels. A failed fresh read must
remain unreadable instead of falling back to the previous snapshot.

The shared CLI GraphQL page fixture must include the commit `oid` and contexts
`totalCount`/`pageInfo`; a flattened `gh pr view` response alone never attests
completeness. Pre-stage's targeted reread and operator landing use the complete
check/status reader before forwarding provenance. Preserve the pre-stage
incomplete/wrong-head matrix and operator unreadable-status refusal.
The ordinary drain's fresh merge revalidation also hydrates from the complete
check/status reader; its flattened `gh pr view` rollup is insufficient. The
pre-stage CLI suite pins unreadable check-run and commit-status refusal before
enqueue, alongside the successful ordinary cascade and cached pre-stage paths.

Hermetic ordinary-drain CLI shims use `scripts/__tests__/fixtures/complete-check-read-fixture.mjs`
to serve the complete paginated check-run and legacy-status endpoints from their PR database.
The real reader supplies provenance only after both reads. The helper refuses unknown heads
and absent rollups, preserves failing/pending/wrong-head rows, and leaves targeted freshness
reads to the caller. A flattened PR view alone must never acquire completeness metadata.

The shared in-process pre-stage ports must serve both complete REST endpoints and the
unreadable-endpoint overrides; keep async `run()` calls awaited in transplanted CLI tests.
Queue-owned BEHIND revalidation retains its bounded GraphQL rollup read after REST hydration.
That reader attests `rowsHead` only after validating the commit identity and exhausting the
connection; retention consumes that provenance rather than deriving it from `headRefOid`.
`merge-ai-prs.test.mjs` pins absent/other-head retention refusal alongside the bounded-read cases,
and `reconcile-core.test.mjs` pins incomplete/other-head refusal even with review-owned red holds.

CI-heal escalation's default reader also hydrates through `readReviewChecks` before judging
gate-only red. Its transport fixtures serve both paginated REST endpoints, without adding
provenance to flattened PR facts. Keep default-reader regressions for green tests plus a red
review gate and incomplete/unreadable responses from either endpoint; the latter must report
unknown via the existing read warning rather than claim CI is green.
Reconcile hydration preserves complete current-head snapshots even at or above 100 rows.
Its fallback uses the same paginated check-run and commit-status reader, carrying that
reader's provenance through normalization. The required-checks pass suite and the
`review-ci-ignores-incomplete-rows` soak cover preservation, successful hydration and
unreadable feeds; bare injected arrays still cannot attest completeness.
External agy review jurors bound silent launches with `review.externalJurors.firstOutputMs`
(default 120000; 0 disables). A silent kill records `provider-unresponsive` and uses the
existing quota evidence store's root for a hold across every backend, for `cooldownMs`
(default 1800000). Advisory skips retain the window and cooldown in their summary;
mandatory skips and an unmet `minNonClaudeSeats` block on infrastructure. New runs seat
the fifth juror through `advisorySeats.antigravityReview` (default off), independently of
probation; a saved run retains its roster. Regressions: `external-juror-liveness.test.mjs`,
`review-pr.test.mjs`, and `agy-juror-first-output.soak.test.mjs` (the latter uses the soak
Vitest config). Run only the affected files through heavy-admission.

