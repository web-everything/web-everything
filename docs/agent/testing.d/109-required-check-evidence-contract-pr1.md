## Required-check evidence contract (PR1)

`resolveRequiredChecks` ships without production callers. Its acceptance tests build
job/head-bound hold annotations inline; no caller or hold-classifier change is required.
Every required name needs its own evidence, a live/cache roster, an exact head and
`rowsComplete: true`. Missing or false completeness returns `unknown`; neutral/skipped
conclusions fail unless the exact name is in `optionalNames`.

The fetch tests prove completeness only from matching connection counts, valid nodes
and `hasNextPage: false`, and preserve the commit read head independently of the PR head.
Legacy hydration reads at most ten batches of twenty heads. Unreadable, truncated or
overflow evidence remains incomplete for retry on a later tick or operator inspection;
an incomplete refresh preserves previously observed failures. Retry by exhausting
pagination or explicitly reading every required name before attesting completeness.


