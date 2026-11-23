## Drain CI pre-stage

The drain caches non-CI gate dispositions for accepted pending heads carrying `ready-to-merge` in coordination storage,
bound to repo, PR and head. Green check events may consume this preparation before listing;
head, label, body/base changes and TTL expiry require the full fast drain. So do the live fields the full
classifier reads that move no cached signature: a `CHANGES_REQUESTED`/`REVIEW_REQUIRED` review decision,
`mergeable` other than `MERGEABLE`, and a merge state other than `CLEAN`, `UNSTABLE` or `BLOCKED`. The required
set is GitHub's queue-required checks plus the drain's own `--check` (`prestageRequiredChecks`): a failed selected
check is never prepared, and the green event re-checks the `--check` it was invoked with. It reads that check
through the same full read as the listing (`resolveRequiredCheck`, past gh's 100-context rollup cap); a failed
full read falls back. Every required
context needs its own successful row before enqueue; missing, pending, cancelled and red
contexts never authorize enqueue. A newly failed optional CodeQL check also vetoes admission when
`drainBlocksOnCodeQL` is enabled. Red-team evidence and the complete comment thread are re-read at enqueue;
the cache never substitutes for live release-label or red-team authorization. `checking` alone is ineligible,
including at the event wake boundary. Cached admission also reads the live fix claim before admission and
again inside the locked enqueue callback: a claim acquired while waiting for the lock must still veto enqueue.
`enqueuePrestage` owns that in-lock re-read (`fixClaimHeld`), the cascade's pre-landing steps (`beforeEnqueue`:
the review-coverage notice and the stacked-PR retarget) and the post-enqueue ledger facts (`recordLanded`,
the same recorder the cascade calls after a confirmed enqueue: exemption, restamp, drain-hold release); it
refuses the shortcut when any of them is not wired.
Check-event marks lack required-context identity and head SHA: preserve pending wakes on non-success marks,
then let the live required-check read drop red preparation. Coupled candidates, manifest-carrying heads and branches requiring preparation
keep the full cascade. Keep pre-stage tests separate from ordinary classification tests:
preparation may evaluate the remaining gates while CI is pending, but must leave the real
merge cascade before any enqueue. Regression home: `scripts/lib/__tests__/drain-prestage.test.mjs`.

Pre-stage regression contracts (PR #5480): every enqueue entry point must cover throwing mutations
(including required-workflow, conflict and unreadable-state failures). A shortcut refusal drops its cache
and falls back without installing backoff that hides the error from ordinary cascade recovery. Keep
table-driven coverage of every GitHub check conclusion at the `enqueuePrestage` boundary (not only at
preparation), missing release labels, evidence added after
preparation, optional CodeQL failures, coupled candidates and branch preparation. Include claims acquired
after preparation, unreadable claim readers, and exceptions propagated through an async lock. The CLI fixture must
assert pending manifest candidates cause no head writes or review writes, including a stale acceptance.
The provisional `merge` disposition is used only to evaluate gates: collision healing, manifest rebuilding,
review-label provisioning, clearance carry, baseline/ledger writes, parking and skip comments must suppress
writes for `prestagePendingCi`; the actual merge set excludes these candidates.

Source-contract tests for review writes must follow `candidateDryRun` and assert that it includes both
`DRY_RUN` and `prestagePendingCi`. Queue fixtures must record membership only after a successful enqueue
response; recording a refused mutation as queued masks the ordinary recovery attempt with an idempotent success.

Prevention follow-up owed by this review: add an enqueue-call lint that recognizes both enclosing
try/catch and callbacks protected by `enqueuePrestage`. It must flag unprotected `mergeStrategy.enqueue`
calls without treating the protected callback as an uncaught call. The throwing-entry-point regression
contracts above are the immediate guard; the repository-wide lint remains separate tooling work.

The green-event shortcut must honor the full drain's resolved `--repos` / `--this-repo`
selection and exact `--label` / `--base` filters before consuming preparation. The listing and the
shortcut share one selection predicate (`operatorSelects`), so a new filter cannot reach only one path.
CLI regressions must pair excluded scopes (WE#42 under `--repos=frontier-ui/frontierui`, including the short
repo alias, cached main preparation under `--this-repo --base=release`, and cached `ready-to-merge`
preparation under `--label=other`) with matching scopes that still enqueue without listing. Excluded
repo/label/base scopes preserve preparation. A green mark that arrives while its PR's fast drain runs
must wake it again after that run (`enqueue-on-event.test.mjs`, "pre-staged green events").

