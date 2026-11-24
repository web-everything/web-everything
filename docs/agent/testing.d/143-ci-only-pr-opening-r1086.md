## CI-only PR opening (R1086)

`pr-land --verify=ci-only` is restricted to open modes and observed host saturation.
It ignores the local finish marker and reuses the deferred disclosure/body-sync and exact-SHA
CI `test` label gate. Unknown CPU/load evidence and memory-only admission refusals cannot
authorize it. Audit records live in `verify-ci-only`, separately from `verify-green`;
`WE_VERIFY_CI_ONLY_LEDGER_DIR` explicitly selects an audit directory for fixtures.
The scoped `scripts/lib/__tests__/verify-ci-only.test.mjs` exercises these boundaries.
