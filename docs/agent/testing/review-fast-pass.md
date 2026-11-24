# Review fast pass

Run `node skills-src/conveyor/review-daemon.mjs --fast-pass --once` for one pass,
or omit `--once` for the independent leased process. The default interval is 105 seconds;
`WE_REVIEW_FAST_PASS_INTERVAL_MS` accepts 90000–120000 milliseconds through the policy cascade.

The ordinary daemon saves one atomic `.conveyor/review-fast-plan-*.json` snapshot per repo.
The fast pass combines saved review rows with currently pending PRs absent from the saved pending
set. Every candidate needs a fresh head, labels, checks, comments, agents and live job inventory.
The complete single-PR planner runs again with fresh main-red facts. Changed or unreadable main
SHA evidence defers to the ordinary tick; no old main-red enrichment is transferred.

The fast pass uses a separate runner lease. The real dispatch wrapper retains the stale-clone,
CI, head-binding and job-slot guards. Live job records and the current process budget both bound
capacity. A missing snapshot, incomplete inventory, oversized inventory or refusal is logged and
deferred to the ordinary tick. Each pass probes at most eight candidates per repo, prioritizing newly
pending work over saved rows; remaining work
stays with the ordinary tick. The event wake is not implemented.

Run the two `scripts/lib/__tests__/review-fast-pass*.test.mjs` files through heavy-admission.
The `review-pending-fast-pass.soak.test.mjs` break needs `--config vitest.soak.config.ts`;
the default unit configuration excludes soak files. Its fix probe executes the implementation
from the supplied tree, so source markers alone cannot classify the fix as present.
