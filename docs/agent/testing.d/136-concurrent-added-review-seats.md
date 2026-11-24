## Concurrent added review seats

Added-seat evidence uses the loop read sink with `review.extraSeats.concurrent` (standard true,
platform → tool → environment `WE_REVIEW_EXTRA_SEATS_CONCURRENT`; the job logs value and source).
The extra-seats kill switch still wins. The single-shot `run` command remains speculate then finish.
A speculative pass writes reservations before calling providers, and writes comparison rows only
against the final pinned loop head. Bounce, park, infra block, missing input, failed pass, moved
head, and final-head skip discard spend without a sequential rerun. The red team and added seats
share the sink when both start; only its owner removes it. Job-summary timings include `loopMs`,
`seatsMs` (pass duration when available), `seatsConcurrent`, and total wall time including settlement.
Scoped regressions live in the review-extra-seats and review-job-speculative-red-team tests; the
`added-seats-concurrent-head-binding` soak break decides fix presence by executing both head cases.

Discarded added-seat quota rows retain each call’s `finishedAt` (falling back to `startedAt`),
so settlement order cannot let an older clean call clear a newer exhaustion hold.
`review-extra-seats-discard-quota-order.test.mjs` covers both timestamp sources and append orders,
including a newer clean call clearing an older hold. Replaying an old discarded call must not
re-arm the probe interval; a fresh exhausted call does.
