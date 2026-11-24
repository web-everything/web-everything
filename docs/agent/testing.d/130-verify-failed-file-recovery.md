## Verify failed-file recovery

`verify.retryFailed` (`scripts/verify-settings.json`, env `WE_VERIFY_RETRY_FAILED`) defaults to 1,
accepts 0–10 attempts, and logs its effective value/source. Zero retains the historical
`isolatedRetry` policy. Positive values retry up to three failed files per Vitest/scan/guard
phase, including edited files, using serial workers and the phase's scaled timeouts. `isolatedRetry=off`
disables all retries; `isolatedRetry=timeouts` permits only timeout-only failure inventories, including
on later attempts. These restrictions also apply to scan and guard retries. A complete
failure inventory and a JSON report proving the original failing assertions passed are required;
missing, skipped, or incomplete execution never clears red. Every duplicate of an original full test
name in that exact file's retry report must pass; a passing namesake cannot mask a skipped test.
Oversized/incomplete inventories stay red: fix the failures or run a fresh verify. The recognized full-unit default separates tests
from standards; opaque explicit combined commands retain their verdict. Recovered files appear in
marker `flakes` and the advisory coordination-root `.operations/test-flakes.jsonl`; merge CI is unchanged.
Full-unit recovery requires a runtime read proving the target checkout's `test:unit` is exactly the
heavy-admission `vitest run` script with neither `pretest:unit` nor `posttest:unit`. Missing, unreadable,
malformed or oversized package evidence leaves the full gate opaque. Scan retries retain the original
command's environment assignments, including `VERIFY_SCAN_FILES`; an unrecognized assignment or shell
shape refuses recovery. Both refusals retain red: fix the failures or run a fresh verify.
`verify-retry-context.test.mjs` covers package evidence and an untracked deterministic scan violation.
