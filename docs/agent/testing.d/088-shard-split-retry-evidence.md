## Shard split-retry evidence

`verify-shard-run` retries incomplete inventory once in at most two halves to surface
failures. The first TIMEOUT, NOT-RUN, or FAIL half
keeps its status (TIMEOUT/NOT-RUN exit 124). Otherwise, observed failure evidence
makes the shard FAIL (exit 1). The shard settles PASS (exit 0) only when every half
passes with exit 0, no signal, and complete inventory; the halves together cover
exactly the shard's files; and every assertion in every reported retry file is
`passed`, with no observed failure, infrastructure exit, or load deferral.
Missing assertions and pending/skipped/todo assertions keep it UNSETTLED,
as do missing or oversized half reports, load deferral, or an unresolved exit 75.
Every other retry outcome is UNSETTLED (exit 75). Retry output and
failure details remain visible, and each shard contributes one final result.
Admission forwards child exit codes, so exit 75 cannot prove the command never ran;
nonzero exits other than 75 are failure evidence even without inventory, and
cannot be cleared by passing retries. Exit 0 or 75 with missing inventory remains
unsettled-eligible in the absence of failure evidence. Ordinary complete remote
failures can be cleared by a complete passing confirmation: local in the shard wrapper,
a second Forge job in ordinary phases (Mac fallback only when Forge is unreachable).
Incomplete shards retain failure evidence, including
a complete remote failure or nonzero exit followed by incomplete local confirmation
and passing split retries.
Infrastructure
exits retain their classification, and UNSETTLED retains `verify-unsettled` only
when the caller supplies no failing-test identities (`failureDetails.tests` is empty
or absent); an empty collector object or progress summary is not a test failure.
Exit 75 with recorded failures stays red and does not authorize confirmation
in either path. Ordinary remote phases confirm a reported remote exit 75 without
failures on Forge because the nested admission wrapper can use it for deferral. The shard wrapper owns its
own confirmation and retry, so its terminal UNSETTLED result is never confirmed
again by verify-lane. Signals, watchdog timeouts, unknown run locations, and
reported local failures still prohibit remote confirmation.
First-attempt passes are unchanged. The scoped regressions live in
`scripts/lib/__tests__/verify-shard-run.test.mjs`; run them through heavy admission.
The cross-path confirmation policy is pinned in `verify-remote-routing-shard.test.mjs`,
and `verify-lane.test.mjs` exercises exit 75 without FAIL output through the real CLI.
Child report identities re-emitted as FAIL lines must strip C0/C1 controls and Unicode
line separators; the hostile-input table checks the resulting failure collector entries.
When changing an existing test's expected verdict, disclose the behavior change in
the PR description so reviewers can distinguish a policy change from a regression fix.

Persistent GitHub 5xx soak fixtures must account for both retry ladders: `withListRetry`
repeats the list read three times, and each attempt can sleep again in `gh-throttle`.
The `smoke-github-outage` break pins `WE_GH_LIST_BACKOFF_MS=5,5` and
`WE_GH_JSON_RETRY_BACKOFF_MS=5` before the daemon forks. This preserves exhausted,
fail-closed reads across reconcile and dispatch smoke passes within the unchanged
90-second tick bound; shortening only the outer list backoff does not suffice.

