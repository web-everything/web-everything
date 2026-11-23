## Post-accept advisory shadow evidence

`review-loop-policy.test.mjs` exercises invalid settings with advisory-only findings, concurrent
ledger writers (including separate Node processes), malformed persisted rows, and later loop
observations. Accept-time `loopsAfter: null` means unmeasured; only later `kind: loops` observations
supply measurements. A numeric accept-time count seeds the per-accept measurements; only higher
counts advance the latest value per repo/PR/head. Equal or lower explicit replays append nothing,
and historical replay rows cannot lower the report or the next run's count. The named accept-count,
persisted-replay, and interleaved-accept probes in `review-loop-policy.test.mjs` pin these guarantees.
`review-loop-cli.test.mjs` compares every live effect against mode off for an
advisory-bearing accept, including settings and recorder failures.
Persisted observations lock beside the ledger for at most two seconds. A busy/orphaned lock
reports a shadow miss and preserves live review; an operator can inspect the writer and remove
an orphaned `.lock` before retrying the observation.

