## Async drain worker CLI fixtures

The in-process merge drain harness ports `node drain-gh-async.mjs <bounds> <gh args>`
through the real synchronous throttle to its fake gh function port. Preserve the serialized
timeout and hard child kill signal, drain caller attribution and read-memo exclusion when updating this seam.
Unknown subprocesses still fail the harness even when a best-effort reader catches them.
`merge-ai-prs-listing-dedupe.test.mjs` covers successful listings and worker failure with
the CLI's `gh-error` exit; `merge-ai-prs-prestage.test.mjs` covers paged heavy reads and enqueue gates.
Use `keepAliveScript` for the hung-gh timeout fixture in `drain-gh-async.test.mjs` so it
stays anchored to the test runner with a maximum lifetime if timeout cleanup is interrupted.
The async drain executor uses SIGKILL for gh timeout termination, including when callers omit
the signal or request a soft signal: synchronous child waits otherwise remain blocked when gh
ignores that signal. Keep the worker alive through child reaping and throttle-slot release.
The parameterized soft-signal regression checks elapsed time, child exit and slot cleanup with
real subprocesses; the existing explicit-SIGKILL case pins the hydration callers' behavior.
