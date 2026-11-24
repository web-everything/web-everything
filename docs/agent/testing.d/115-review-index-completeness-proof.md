## Review index completeness proof

Appending a review id is only a discovery hint. Trust requires a completed backfill's
`completeThroughMtimeMs`, stat-only id/mtime/file-identity snapshot, rebuilt PR keys, and acknowledged
create-only poison markers. Listing or open-set changes retain verified id/mtime/file-identity
and ownership rows; requeue changed/new ids and drop removed ids. An unreadable or mismatched
candidate aborts the batch without publishing completeness, persists verified progress, and
records a blocking id with a 60-second retry cooldown. Other ids advance during cooldown;
completeness remains unpublished until every blocking record is verified or removed. Failed appends poison the whole sidecar independently of its write lock; only a
complete rebuild acknowledges those markers. Readers stat the current listing before parsing
indexed ids. Unknown or rewritten unindexed ids require strict record identity verification
(at most 20 reads, sharing the evidence scan budget); unrelated PR ownership permits the hit.
Same-PR, unreadable or over-bound unknown evidence, missing watermarks, unreadable listings
or new poison markers force the unchanged bounded fallback. File identity also detects atomic replacements with
unchanged mtimes when marker creation fails. Even an older/coarse mtime cannot hide an unknown id.
Oversized snapshots retain the bounded scan and its scan-capped
HOLD; inspect omitted runs manually. Optional backfill side effects, including argument and
directory resolution, must return the drain context unchanged on exceptions.
For every bounded-read risk, the test plan must name a regression counting actual read attempts
or asserting the read range, including the default shared budget across repositories. Inject a
failure after a successful staged read to prove no partial completeness can be published.
Index verification payloads may serve the bounded fallback only after rechecking the file
identity captured before the read (mtime, device, inode, size, ctime and birthtime). Changed
identities discard cached payloads and read errors; fresh attempts still consume the shared
parse budget. The unchanged one-read fallback and unchanged-mtime atomic-replacement cases
in `review-run-index.test.mjs` pin both reuse and stale-cache refusal for drain and recovery.
Both backfills must count payload attempts before calling the reader and retain that count
outside staging, so aborts, listing churn and failed persistence cannot refund the shared
50-read drain budget. The `%s backfill preserves payload spend after %s` cases and the
`an aborted open-PR backfill leaves only the actual remainder after %s` drain cases pin this
accounting. The open pass receives at most 25 of the shared 50 reads; unused reads go
to the full pass, which always has at least 25 reads when the open pass obeys its cap.
Unknown spend exhausts the open allocation, preserving the full pass's reservation.
The repeated saturated-tick regression in `merge-ai-prs-review-backfill.test.mjs`
pins full-pass completion without exceeding the shared budget. The bounded evidence scan and scan-capped HOLD
remain the fallback until a later tick can complete discovery.
Keep the lost-append, poison, complete-hit, churn, cooldown, budget and wiring regressions in `review-run-index.test.mjs`, run alongside `drain-red-team-evidence.test.mjs`
through heavy admission.
