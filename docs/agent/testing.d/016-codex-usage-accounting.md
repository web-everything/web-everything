## Codex usage accounting

Every direct task, Codex delivery/fix worker, wrapped Codex dispatch worker, and Codex review
seat appends through `scripts/lib/codex-usage-ledger.mjs`. The default ledger is
`<daemonConveyorStateRoot>/codex-usage.jsonl`; `WE_CODEX_USAGE_LEDGER` overrides the file.
Direct CLI attribution flags are `--caller`, `--repo`, `--pr`, `--card`, and
`--usage-task-kind` (an accounting label that preserves model routing).
Redirect the ledger to a temporary file in tests. Append/probe failures must preserve the launch's result
or original error. Unknown tokens, quota, file changes, and exit codes stay null; quota resets have no delta.
Persist repository identities as `owner/name`, stripping remote credentials, queries, and fragments.
Worker-writable snapshots use the shared Git hardening, refuse lane-defined filters, and never read
worktree contents or run Git diff/conversion commands. Fingerprints include HEAD, index entries,
and nanosecond file metadata; touches can count as changes. Snapshot limits are 4096 untracked
paths, 65536 tracked entries, 8 MiB per Git output, and a five-second budget. Lazy fetch is disabled;
submodules, sparse directory entries, and unsafe or incomplete snapshots record unknown file changes.
Delivery providers accept `usageTaskKind` separately from routing `taskKind`.
Quota is sampled from the newest persisted Codex rollout observations, so ephemeral runs may
have no fresh observation and concurrent runs can contribute to the observed bucket delta.
`node scripts/codex-usage-report.mjs --since=24h` (or `--json`) reads without launching Codex.
Cached input is a subset of input; reasoning is a subset of output when reported, not additive spend.


> Tier-1 reference. Read when writing or changing tests.

Keep the 50-tick daemon soak baseline alone in shard 1 when splitting the soak suite. Balance break
scenarios by measured time across the remaining shards; timing estimates must never put a sibling
scenario beside the baseline. Those scenarios fork real daemon and git children, so concurrent worlds
can exhaust the baseline's wall-clock timeout while its per-tick invariants continue to hold.

Injected Gemini subprocess tests must set `ANTIGRAVITY_QUOTA_DIR` to a per-test temporary directory:
real backend holds otherwise prevent even the fake child from starting. Real POC branch-sync fixtures
must pass a temporary `lockRoot` through `withPocLandLock`, preserving the mutex without touching host locks.

