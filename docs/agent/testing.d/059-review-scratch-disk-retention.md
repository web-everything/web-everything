## Review scratch disk retention

Review seats use independent shallow pinned checkouts: a released lane's objects cannot be
borrowed safely across reset/GC. Own the scratch immediately after allocation, clean failed
setup as well as the run's `finally`, and register catchable signal/exit cleanup. SIGKILL and
host crashes require the health-watch backstop. Ephemeral review paths bypass the persistent
backlog index to avoid a full snapshot for every seat.

Signal cleanup stops seats before deleting their checkouts. Direct-task wrappers receive
SIGTERM so their handlers can kill the models' separate detached process groups; cleanup
waits for wrapper close. After ten seconds, a stuck wrapper and its observed descendants
(including detached model groups) receive SIGKILL, with one further second to observe close.
Unknown descendant observation or failure to close retains scratch for recovery. The outer
timeout follows the same stop path. Re-check jurors are tracked too. Repeated signals cannot
interrupt that wait or start another seat. Speculative cancellation holds new seats only
until the cancellation finishes; process termination permanently stops further launches.
A synchronous process exit requests shutdown and retains any checkout whose stop cannot
be awaited. Retention survives callers' `finally` blocks for the health-watch sweeper.
Ownership metadata lives at the sibling `<scratch>.owner.json`, outside the pinned worktree,
so a tracked `.we-review-owner.json` cannot block checkout or forge the owner PID. Normal
cleanup and the sweeper remove the sibling metadata together with its checkout.

Each health-watch tick sweeps `we-review-seat-*`, `we-red-team-recheck-*`, and
`we-overlay-dispatch-smoke-*` older than
`config.json`'s `tmp.reviewSeatTtlMin` (120 minutes), preserving live owner PIDs and process
working directories. Allocation and recovery share the review prefix constants. Busy cwd
observation runs once only when an expired candidate needs it; unknown observation preserves
checkouts. It also caps all
`we-backlog-index-*` files together at `tmp.backlogIndexMaxMb` (2048 MiB), oldest first.
Sweep logs include counts and bytes freed. Symlinks are never traversed.
The `disk-space` smell probes available space on the checkout's writable data filesystem:
warn below `health.diskFreeMinGb` (30 GiB), critical below 10 GiB. It opens immediately,
notifies in shadow mode, and sends an opening event through the needs-you feed's serialized
publisher. Host, subject and opening time identify each event, including reopenings within
the same minute. Fixture state roots and dry runs never publish these events.

### Tests-first delivery settings

Prepared open cards must replace the Acceptance scaffold's `TODO: a command` with executable
acceptance, one `[A<n>] Executable` line per guarantee. Unprepared cards remain exempt. Builders
run and record failing acceptance tests before implementation, make their first commit contain
only those new or updated tests, and report the named tests' red-then-green results. Reviewers
map every stated Acceptance guarantee to a named test and report missing mappings as findings.

`build.requireExecutableAcceptance`, `build.redFirst`, and `build.guaranteesMapToTests` default
ON. They resolve through the shared policy cascade: standard → platform → repository
(`scripts/settings/tests-first.json`) → environment (the `WE_BUILD_*` names documented there),
with each source logged. Dispatch strips disabled brief sections. The verify step's first-commit
check applies to build lane branches and delivery leases on local `main`, and warns if no test was added or updated; this advisory
cannot prove a red run. Git-read errors are reported as unknown rather than evidence of compliance.

