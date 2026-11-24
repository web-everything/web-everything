## Automated repair hand-offs

`review-set-label` and the red-team gate signal the local fix daemon after a successful
send-back. CI lifecycle/status writers use the same `scripts/lib/fix-handoff.mjs` wake
path after their existing classification; they do not classify failures a second time.
The mailbox survives signals during a tick; one-second file polling interrupts the plain
sleep without consuming native filesystem watchers, and the optional webhook sleep also checks the mailbox. `WE_FIX_HANDOFF_DIR`
provides an isolated mailbox for tests. A wake only schedules a normal pass; claims,
scope, host admission and attempt budgets remain authoritative.

Pinned plain re-arm fixtures must exercise the partial state between the label swap and
the durable marker: three failed comment attempts restore the pre-swap labels, while a
pending PR resumes by posting only its missing marker. Inject `rearmRetrySleep` to avoid
real delays. Assert head checks on comment retries and rollback, trusted verdict-bound
coverage in thread order (including the same timestamp second), and round counts after
rollback and successful retry. A rollback failure must name the unmarked pending state.
Compensating label writes must also revalidate the complete trusted review evidence
and the review/readiness labels created by the swap. Exercise a same-head human
clearance on the third failed comment attempt, a newer or edited verdict with labels
still pending, changed holds/readiness, and unreadable state. Refuse compensation
when superseded; preserve unrelated labels and ignore untrusted verdict claims.
The `pinned-rearm-orphan-marker` soak replay retains one provider's PR state across
exhausted HTTP 503 retries, successful or failed rollback, and subsequent retries.
Assert that failed rollback resumes with only a marker write, a completed retry writes
nothing further even within the verdict's timestamp second, and rollback spends no
repair round or bypasses the orphan redispatch cap.

The shared policy cascade resolves `fix.sendBackReservedSlots` (standard 1),
`fix.ciMissingAfterPushMin` (standard 10), and `drain.mergeableUnknownRepollSec`
(standard 20), independently through platform preferences, declared tool settings and
`WE_FIX_SEND_BACK_RESERVED_SLOTS`, `WE_FIX_CI_MISSING_AFTER_PUSH_MIN`, and
`WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC`. The cascade logs the value and source in
daemons. Ordinary repairs cannot consume reserved slots, even after memory pressure
reduces the effective cap; a send-back still needs host admission.

The fixer pusher ensures `checking` and `status:awaiting-ci` exist before marking its new
head with them. Test an initially empty repository label catalog and a same-head retry;
`gh pr edit --add-label` refuses labels that have not been created. The existing
`ci-red-recovery-watch` missing-run pass re-requests absent CI after the configured
age (using a recorded fixer push time when available), retaining its conflict, claim, head and retry-budget guards. The drain re-reads
UNKNOWN listings before collecting head-bound context and also revalidates before
merging, waiting for the configured delay at most three times per read stage.
Before listing re-polls, a bounded REST GET trigger requests mergeability computation for up to ten unknown or empty candidates without changing their facts or classification.
Hermetic drain CLI fixtures with synthetic UNKNOWN reads pin
`WE_DRAIN_MERGEABLE_UNKNOWN_REPOLL_SEC=0` while retaining the retry count and
merge/hold assertions. Several read stages can otherwise exhaust a child-process
deadline with production waits alone. Verify production delay defaults separately
in the retry helper tests.

### Overlay dispatch launch timeouts

The real overlay dispatch smoke keeps its five-minute budget per attempt. Resolve
`overlaySmoke.dispatchLaunchRetries` through the policy cascade (default 1, allowed 0–1;
`WE_OVERLAY_DISPATCH_LAUNCH_RETRIES` overrides it) and log its source. Retry only a timeout
with no marker file, completion record, Claude session file, or transcript. Use a fresh
scratch store and session ID, retain both attempts' diagnostics, and report
“retried after launch timeout” on recovery. Assertion failures never retry.
The smoke opts into wrapper stderr capture and first-byte timing; missing output is
represented by `firstOutputMs: null`, not zero. Failure alerts retain the wrapper PID,
liveness at timeout, launch time, session/transcript presence, the error class and the path of
the 0600 file holding the last 30 stderr lines; the wrapper's raw capture is removed after each
attempt (see *Daemon entry boot smoke* above).
Exercise the launch with injected processes and isolated homes; wrapper output capture
also has a real Node-child probe in `worker-wrapper.test.mjs`. Run these suites through
`node scripts/readiness/heavy-admission.mjs run -- npx vitest run <files>`.

