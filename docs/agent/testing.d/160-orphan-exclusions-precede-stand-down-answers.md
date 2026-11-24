## Orphan exclusions precede stand-down answers

The fix-dispatch orphan guard must reach `runReconcilePass` before R123 enrichment,
which can reserve and post an operator answer before dispatch rows exist. Adapt
dispatch predicates to PR numbers (`number` or `prNumber`); do not depend on labels
at this boundary. Keep excluded PRs in the plan with their original unanswered
comments and retain the later dispatch filter. `reconcile-pass.test.mjs` exercises
the real auto-proceed writer with injected IO: the excluded PR gets no thread read,
reservation or post while a non-excluded PR receives an answer.
`reconcile-fix-dispatch.test.mjs` covers both exclusion forms and the empty no-op.
