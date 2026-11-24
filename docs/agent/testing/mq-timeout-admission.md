## MQ timeout admission

MQ timeout admission is a complete-log proof: every failed Vitest test needs its own FAIL heading
and `Error: Test timed out in <N>ms.` headline, matching failed-test/file totals and the final exit
annotation. Failed `test`/`coverage-merge` jobs need positive upstream-gate logs. Missing, oversized,
unreadable or mixed-cause evidence retains the operator hold. `drain-mq-timeout-retry.test.mjs`
and the behaviour-decided `mq-timeout-same-head` soak cover this rule. Preflight reads the shared
MQ failure ledger; only admission at the enqueue mutation boundary consumes the one allowance
keyed by repo/PR/head. An ambiguous enqueue failure consumes it too; operators inspect and enqueue
manually after it is spent. Run the soak wrapper with `vitest.soak.config.ts` through heavy admission.
