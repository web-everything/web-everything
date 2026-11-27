# CI job resource profiles

## Contract

`job-profile.mjs` measures the wrapped command's process tree (sampled peak summed
RSS, reaped CPU exactly, orphan CPU as a lower bound), writes one fixed-field v1
JSONL record, and exits with the wrapped command's own exit code. Exceptions are
argument errors (2), spawn failure (127), and forced kill after the signal grace
period (128 + the first forwarded signal). Telemetry failures are reported on
stderr and never change a job verdict.

```sh
node scripts/ci/job-profile.mjs --job='test-shard (1)' --out=job-profile.jsonl -- npm run test:unit -- selected.test.mjs
node scripts/ci/job-profile.mjs --summary downloaded-artifacts
```

The output defaults to `job-profile.jsonl`; `--proc-root` defaults to `/proc`.
Without `self/stat`, the command runs unprofiled, writes no record, and prints
`job-profile: no /proc, skipped`. Other unreadable or malformed evidence produces
an `error` record with unknown metrics set to null, never a measured zero.
Diagnostics have the form `job-profile: <phase> failed <code>`.

The child inherits cwd, environment, argv and stdio. Polling runs immediately,
every 500 ms, and once more at child exit. Stat fields are parsed after the last
`)`; identities are `(pid, starttime)`, preventing PID reuse from merging samples.
Peak tree RSS sums `VmRSS` over all current descendants. Peak process RSS is the
largest individual `VmHWM`. Both values use MiB, rounded down. Processes that
vanish or deny reads between listing and reading (ENOENT, ESRCH, EACCES) are
omitted from that poll. A process positively identified as a zombie (`Z` in
`stat`) is omitted from memory sampling because it has released its memory and
its status can lack `VmRSS`/`VmHWM`. The identity/state recheck after reading
status also handles live-to-zombie transitions during a poll. Missing memory
fields on a process that is still live remain an error. Other errors invalidate
the measurement.

`reapedCpuSec` is the wrapper's change in `cutime + cstime` across the root's
lifetime, divided by `getconf CLK_TCK`. The baseline is read after getconf;
between baseline and final accounting the wrapper spawns only the root.
`orphanCpuSecLowerBound` sums the last observed **self** `utime + stime` of
descendants observed reparented outside the tree, or still alive at root exit.
It excludes descendant CPU that parents waited for; that CPU belongs to the
reaped component. A descendant that appears and reparents between polls may
never be discovered. Work after the last observation is also missing. These
are lower bounds, and sampled memory can miss spikes shorter than 500 ms.
`samplerCpuSec` measures the wrapper's own CPU over the same accounting interval.

SIGINT and SIGTERM are forwarded to the root while sampling continues. After
30 seconds without root exit the wrapper sends SIGKILL to the root and exits
128 + the first signal. Descendant cleanup remains the CI runner's job.
`JOB_PROFILE_GRACE_MS` optionally selects an integer in 1–30000 ms; invalid
values refuse invocation before spawn. The effective override and its environment
source are logged to stderr. This operational bound is independent of job timeouts.

## Record schema

Each line contains only these fields:

| Field | Source / meaning |
| --- | --- |
| `v` | `1` |
| `repo`, `workflow`, `runner` | `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW`, `RUNNER_NAME`, or empty string |
| `job` | Required nonempty `--job` label |
| `intervalMs` | `500` |
| `peakTreeRssMb`, `peakProcRssMb` | Sampled tree peak and individual high-water mark, MiB |
| `reapedCpuSec`, `orphanCpuSecLowerBound`, `cpuSec` | Reaped, observed orphan, and their sum |
| `samplerCpuSec`, `wallSec` | Sampler CPU and monotonic elapsed seconds |
| `avgThreads` | `cpuSec / wallSec`, null when wall time is zero |
| `exitCode` | Wrapped command verdict |
| `at` | UTC timestamp |
| `error` | Optional named telemetry failure(s); measured resource fields are null |

No other environment values or command arguments are recorded. A partially
written line may remain after a write failure. The next append first adds a
newline if necessary, preserving independent record boundaries. Writes are
single-wrapper per shard; this format does not provide concurrent-writer locking.

## Summary

Summary recursively reads `*.jsonl`, including nested artifact directories. It
skips invalid JSON, versions other than 1, empty/non-string job labels, and
nonfinite/non-numeric `peakTreeRssMb`, `cpuSec`, `samplerCpuSec`, `wallSec`, or
`exitCode`. Error records are skipped. Optional runner/timestamp values must be
strings. Duplicate `(job, runner, at)` identities keep the first record; distinct
runs remain separate rows. Rows sort by job, timestamp, then runner using string
order. Columns are job, runner, at, peakTreeRssMb, cpuSec, avgThreads,
samplerCpuSec/wallSec, exitCode. Ratios are derived from the measured fields.

Totals report `records`, distinct `jobs`, and `skipped` lines. P90 is nearest-rank
`ceil(0.9 * successfulCount)` over **only exit-0** peaks. No successful rows prints
`p90 peakTreeRssMb: n/a`. Empty input prints `no records`; entirely invalid input
prints `no valid records (skipped: n)`. Both exit 0. Unreadable inputs refuse
summary (exit 2), rather than silently omitting evidence. Terminal control
characters in metadata are replaced before display.

Bounds: 65536 process/directory entries, 65536 bytes per proc file or summary
line, 64 MiB per summary file, 100000 summary lines, directory depth 64, getconf
timeout 2 seconds / output 1024 bytes. Symlinks are refused in summary inputs.
Oversized lines count as skipped. Other exceeded bounds name a failure; split
the artifacts or inspect the raw evidence before retrying. Measurement failures
require rerunning the profile; they never establish sizing evidence.

## CI scope and proof

Only the final npm commands of `test-shard`'s coverage and no-coverage steps are
wrapped. Assignment guards, quarantine arguments, runners, timeouts, coverage
and required gates stay unchanged. `Upload job profile` always attempts a
matrix-unique artifact upload, tolerating missing files and upload failure.

The local tests inject proc snapshots, child handles, timers, IO and metadata;
they do not inspect host processes. Allocation and CPU fixtures exercise
accounting without claiming live Linux measurement accuracy. The separate CI
proof must download the head run's artifacts and require exactly one row for
each of `test-shard (1)` through `test-shard (10)`, with sampler CPU / wall < 0.01.
Check hosted runner provenance in **run metadata**; RUNNER_NAME alone is not
proof because `vars.WE_SHARD_RUNNER` can redirect shards. Compare all ten shard
conclusions and the union of `(file, fullName, status)` timing identities with
the merge-base push run. Only the new profiler and workflow cases may differ.
Report wall-time deltas without gating them. This requires a pushed PR and is
not supplied by local fixture tests.

Deferred: Mesa invocation/retrieval, plateau-app, smoke/visual profiling, sizing
formulas, VM overhead, whole-job measurements and choosing `ci-heavy` capacity.
