## Antigravity quota hold evidence

The usage reader's login regression uses the raw ANSI capture in
`scripts/operations/__tests__/fixtures/agy-login-screen.raw.txt`. With fake timers,
assert resolution before startup, zero stdin writes, cleared timers and descendant
cleanup: Escape or an interrupt sent as text can select a login method. Signed-out
snapshots carry only `at` and `status`, never quota windows.

Exercise holds with an injected temporary `dir` in
`scripts/lib/__tests__/antigravity-run-evidence.test.mjs`. Explicit Claude and Gemini
requests read their own backend folders; default or unrecognized models scan
`anthropic`, `google`, and `unknown`. Legacy root JSON holds use the known served
model's backend, falling back to the requested model's backend; unattributed legacy
holds apply globally. Reads leave legacy files untouched. A skipped run retains
`servedModel: 'unknown'` and `modelEvidence: 'not-launched'`; `heldBackend` and
`heldModel` identify the observation responsible for the refusal.

Judge scorecards and run-record telemetry keep the effective agy effort: a model-id
suffix takes precedence, otherwise apply the CLI map and legacy model override.
Use `antigravity-model-effort.mjs`'s shared predicate in both launchers. Regression
coverage lives in `antigravity-judge-spawn.test.mjs`; `parallel-judges.test.mjs` checks
that both drive modes preserve provider effort while retaining the request fallback.

