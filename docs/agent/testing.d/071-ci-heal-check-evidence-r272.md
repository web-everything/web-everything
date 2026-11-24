## CI-heal check evidence (R272)

Check names and required rosters match exactly, including case: a passing `TEST`
never clears a failing or missing required `test`. Only status and conclusion values
are case-insensitive; CodeQL and hold-gate names retain their exact identity.
Every row for a required name must classify green under the shared check-state
predicate. Any failed, cancelled, stale, unfinished, unknown or unreadable row blocks
successful admission, even beside a success. No source tier, workflow run, attempt,
id or timestamp can discard evidence. Compatibility exports `latestAttempts` and
`latestRollupAttempts` retain all rows without ranking or mutation.
The regression suites retain timestamp, metadata, source-tier, undated and input-order
scenarios and require mixed evidence to fail closed. CodeQL failures always block
`not-a-ci-break` and gate-only excusal, including when CodeQL is outside the required
roster and the drain's CodeQL switch is off. A merge-gate name is excusable only when
every non-green row is positively classified as a review hold; each row is classified
independently, so one held job cannot excuse another job's failure or unfinished state.
The escalation CLI reuses `excusePrMergeGateHolds` for head-bound hold evidence, with
`prChecksOptions` supplying hermetic readers. A failed PR or roster read permits recording with a warning; an unreadable merge-gate verdict or freeze read still permits `needs-human` with a warning, but keeps the red-check refusal for `not-a-ci-break`.
Classification errors, including malformed rollup identities, propagate to the CLI's error handler and abort
before any escalation comment is posted. The read-error fallback never catches refusal classification.
`ci-heal-escalation-mark.test.mjs` pins both preflights and both CLI outcomes with nameless evidence beside a required failure.
