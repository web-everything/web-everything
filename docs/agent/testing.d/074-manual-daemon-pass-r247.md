## Manual daemon pass (R247)

`node scripts/operations/run.mjs manual-daemon-pass --daemon=review --pr=123 --repo=owner/name --reason="daemon unavailable"`
runs one existing single-PR dispatch from the module's checkout, resolved from `import.meta.url`
independently of the caller's working directory. It reuses
`assertOperatorCliFresh` with automatic fallback disabled so a manual pass cannot silently move
to another checkout. The event and PR comment identify the executing checkout HEAD as `sha`.

Review uses `dispatchReviewByMode`; red-team uses `dispatchReviewJob({ redTeamOnly: true })`,
which owns the existing seat dispatch, result writing and gate application. Both belong to the
review daemon for health admission. A healthy, non-quarantined daemon refuses unless
`--force-while-healthy` is supplied. Unknown health or corrupt quarantine evidence refuses even
with that flag; restore the daemon-status readers before retrying.
Dispatch leaves `root` to the shared dispatcher's module checkout default, as the review daemon
does. Its lane-checkout refusal still applies; run from an up-to-date control clone when refused.

Fix refuses with “no entry point”: `reconcile-fix-dispatch.mjs#dispatchFix` requires the prepared
daemon plan and `fix-run.mjs#runFixCli` requires a session, ref and prompt file;
`runReconcileFixDispatch` sweeps a repository. Verify also refuses: `verify`/`createChecksRunner`
accepts a checkout, the verify daemon calls `verify-dispatch.mjs#runVerifyDispatch` to scan pools,
and `runLaneGate`/`createVerifyGateJobs.launch` require prepared lane/head/marker evidence.
Neither daemon exports a single-PR entry point accepting repo/pr. These refusals remain explicit until their owners
expose reusable entry points; do not reconstruct daemon planning in this operation.

Admitted passes post a manual R247 PR comment only after dispatch returns, so dispatch refusals
(including the real job/session lane-checkout guard) leave no comment. Every sink attempt, including
freshness/health/no-entry-point refusal, appends one `manual-daemon-pass` JSONL event using the
shared handoff event path (`WE_DAEMON_EVENTS` overrides it in tests). Events retain `at`, `kind`,
`repo`, `pr`, `daemon` and add `ts`, `reason`, `sha`, `result`. Invalid CLI arguments are rejected
by the generated declaration/parser before the sink runs. The effect is non-idempotent, so an
indeterminate run must be inspected before starting a new pass. Focused proof lives in
`scripts/operations/__tests__/manual-daemon-pass.test.mjs`; operation enumeration and declaration
map coverage live in `runner-freshness.test.mjs` and `http-adapter.test.mjs`. `scripts/codemap.mjs`
discovers script modules dynamically and has no hand-maintained operation list.

