## Optional early review and delayed fix push

`review.startBeforeCi` admits an early review only with `hasGreenLedger` evidence for the exact
head. Keep ledger IO in the reconcile/publish shells and skip it when disabled. The existing
red-main hold runs before CI-heal caps; test it with a PR behind main (`aheadByOnMain > 0`),
since a PR already containing main has its own failure. `fix.pushAfterCi` waits before the
agent so completed CI failures enter that same repair's fenced context. Its push boundary uses
the same first-held deadline; unreadable evidence waits until the bound, whose fallback is a
normal push. Inject the clock, sleep and checks; reads must be at least 30 seconds apart.
Claude repairs mark verify directly, so the verify harness must apply the same gate to both
early and green-verdict pushes. Persist its previous head and first-held time independently of
verify retries, retain the waiter on read/write failures, and log the timing policy's source.
`await-verify-pass-push-after-ci.test.mjs` and the `claude-fix-push-after-ci` soak scenario cover
this path with injected CI reads, including the bounded fallback when evidence is unavailable.
Completed previous-head failures must reach the fixer in a shared untrusted-data fence before
either push path runs. Persist the handoff and pending delivery together; retain the inventory
across busy/failed resumes and same-session re-marks until the repair push succeeds. A delivered
resume waits for a new mark; exhausted delivery retains the record for operator recovery.
Exercise busy, paused and failed delivery across multiple ticks with both push policies:
zero pushes until delivery and a subsequent re-mark, then a push of the follow-up commit.

