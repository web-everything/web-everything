## Timeout evidence synchronous worker pool

`timeout-evidence-pool.mjs` runs the unchanged collector once per red PR per pass,
with bounded child process groups and serial fallback for unavailable worker results.
`ci.timeoutEvidenceConcurrency` defaults to 4; 1 preserves the serial path, and
`WE_CI_TIMEOUT_EVIDENCE_CONCURRENCY` overrides the setting (valid range: 1–8).
`timeout-evidence-pool.test.mjs` uses the production worker and a local gh executable
to exercise throttle parity, exit markers and process-group cleanup.
Each detached group carries a watchdog with a pool-deadline-plus-five-second lifetime.
Planner SIGKILL/SIGTERM regressions wait for two real stub-gh workers, kill the planner,
then inspect non-zombie process-group members and the exact pool directory. A SIGSTOP
case keeps the planner alive to exercise the watchdog's independent lifetime bound.
The planner subprocess import uses Node's URL implementation, independent of the DOM
test environment. It waits at most three seconds for both gh stubs and their child PIDs
before atomically renaming the readiness record; the parent polls for at most eight
seconds and includes bounded planner stderr and exit details in readiness failures.
Liveness checks inspect `ps` states: absent processes and zombies are acceptable;
EPERM alone never proves termination. Unverifiable group cleanup propagates through
enrichment without serial fallback. Temp-directory removal is always attempted;
removal failures are logged without changing the result or cleanup error.
Run these tests with `reconcile-pass.test.mjs` through heavy-admission on a host
permitting process-group signals and process inspection.

The timeout-evidence pool fails closed before spawning: planner and worker probes mkdir
the throttle root and attempt to acquire/release a real sync slot. Machinery errors or
failed release after acquisition select serial evidence reads; a busy slot or timeout is
healthy and preserves worker admission. Worker probe failure exits before calling gh.
Worker fixtures use a scratch `WE_GH_THROTTLE_LOCK_ROOT` and explicit throttle cap so
host traffic and inherited capacity settings cannot change whether workers launch.
Probe refusal may emit no stderr: assert forwarding against worker stderr file sizes
captured before cleanup, with an explicit empty-file case that forwards nothing.
The pool is capped
by the live throttle cap. Result/stderr degradation cancels all active groups with the
same verified cleanup before serial fallback, and workers exit inside fail-open warnings
before the throttle can continue ungated. Named pool regressions cover zero-launch
planner refusal, zero-gh worker refusal, both degradation signals and cap bounds.


### Reconcile CLI timing diagnostics

Buffer planner-step timing lines at the reconcile CLI boundary and publish them only
after the whole pass succeeds. Suppressing only the throwing step is insufficient:
a successful earlier step can displace the failure summary used by live-smoke
classification. The CLI timing regression covers a failed read after a successful
step and successful JSON output; the GitHub-outage soak must hold as
`smoke-env-unavailable` without writing a smoke rejection.
Operator prototype-load waiver tests live in `scripts/operations/__tests__/ruled-weakened-store.test.mjs`.
Use an injected HOME and filesystem: the append-only ops store lives under
`~/workspace/.operations/coordination/ruled-weakened.jsonl`. Tool, platform, then ops entries
share the ref/full-SHA/ruling de-dup key; unreadable ops evidence warns and grants nothing.
The declared `ruled-weakened-add` CLI uses an array field with `repeatable: true` so each
`--finding=<string>` appends one verbatim value in order; ordinary array flags still take JSON.
Review lane setup uses one hardened environment for the config scrub, origin validation and fetch.
Global and system config point at the same temporary empty file, system config is disabled, and
inherited indexed config and config-source overrides are removed before applying the hardening
pins. The empty file is removed on success or failure. Before scrubbing, reject effective
`fetch.fsck.*`, `transfer.fsck.*`,
`receive.fsck.*`, and `fsck.*` keys, including worktree and include/includeIf config
(`git config --includes`, without `--local`): object-checking pins do not override severities or skip lists.
An unreadable check refuses fetching; only status 1 with empty output proves no matches.
Lane setup then reuses `scrubRiskyLaneConfig` before fetching, so removing include directives
cannot hide prohibited fsck settings from the check.
Retained `origin.uploadpack` and
`origin.vcs` must never select a command: fetch only the validated repository's explicit SSH URL,
with the lane-pool transport pins (`protocol.ext.allow=never` and
`--upload-pack=git-upload-pack`), plus `submodule.recurse=false` and `--no-recurse-submodules`:
populated submodules retain their own unscrubbed remote helpers. `review-job-fetch-security.test.mjs` uses real local repositories
and marker-writing helpers, proves the hostile fixtures execute through a remote-name fetch,
then exercises the production SSH URL without networking and verifies the marker stays absent.
Any scrub read/removal failure refuses fetching and records an infrastructure failure requiring
lane inspection/repair. Only the scrubber's intentionally retained exact origin keys are exempt.
SSH transport failure surfaces directly; there is no HTTPS fallback. The job suites
cover unreadable/oversized config, inherited global and lane URL rewrites, no fallback, and terminal failure labels.

Operator prototype-load waiver tests live in `scripts/operations/__tests__/ruled-weakened-store.test.mjs`.
Use an injected HOME and filesystem: the append-only ops store lives under
`~/workspace/.operations/coordination/ruled-weakened.jsonl`. Tool, platform, then ops entries
share the ref/full-SHA/ruling de-dup key; unreadable ops evidence warns and grants nothing.
The declared `ruled-weakened-add` CLI uses an array field with `repeatable: true` so each
`--finding=<string>` appends one verbatim value in order; ordinary array flags still take JSON.


