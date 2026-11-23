## Forge worker reservations and Git gates

The fixed Forge wrapper discovers `slot-K` directories and matching system users;
client concurrency settings never define server identities. Pool prepare reserves
`forge-exec-K` through finish using an ops-protected `worker-active-K` directory
bound to run ID and nonce. An interrupted command leaves the reservation closed
until shutdown is confirmed. Age and an empty UID scan alone never authorize
reclamation: acquisition, prepare, execution, and finish hold shared leases on
persistent per-slot `.worker-active-K.writer` inodes. Pruning holds exclusive
leases through scanning and deletion and proves UID process absence before
removing a reservation.
Cancel-finish clears a stale `executing` lock only with both proven UID emptiness and
an `lstat` mtime age at least the hard max runtime, measured with the injected clock.
Before that bound, even successful UID cleanup retains the lock and requires an operator
to stop the reserved UID; failed cleanup also retains it past the bound.
The root supervisor requires reservation evidence and rechecks it under its own shared lease;
a forked child retains that lease through UID drop and closes it before task exec.
Only reservations declaring `writerGuard: 1` participate; historical or uncertain
reservations require operator cleanup. Missing, unreadable, malformed, or incomplete
reservation identity preserves all expired receipts and caches; a known run without
identifiable dependency-lock evidence preserves caches while unrelated receipts
can still expire. The prune tests cover empty historical reservations and resume
age pruning after operator removal. Never unlink writer guard files.
The worker-pool suite pauses a holder before launch, runs the real prune program
against an empty UID inventory, and proves a second controller cannot launch as
that UID. It also tests pruning winning first and refusal at each writer entry.
Hosts without pool directories retain the legacy UID and its own writer guard.
Only `testRoot` fixtures without `testWorkerIdentity` or `testSlotStat` use the
same-UID harness. Production and either explicit isolation injection enforce
worker identity, private groups, slot ownership and identity uniqueness. Pair
injected identities with matching slot stats unless the fixture sets real slot
ownership. Choose synthetic IDs relative to the operator, so host accounts cannot
mask the intended refusal. Model a distinct non-root receipt owner in prune
handoff probes even when tests run as root; otherwise a missing transfer passes.
The privileged fixed wrapper owns metadata operations; tasks and rsync run only
as the reserved UID. Slot roots are ops-owned with the worker's private group
and mode 0710 (traverse only); run containers remain operator-owned. Only work
and sibling trees belong to the worker. Receipts remain ops-only. Worker-owned
0700 slot roots from the earlier pool layout are refused until setup is redeployed.

Every worker ownership handoff opens each component relative to pinned directory
descriptors with `O_NOFOLLOW`, validates ownership, and uses `fchown`. Recursive
handoffs reject hardlinks and hand directories over after their children. Never
use path-following `chown` beneath a worker-writable parent, even for root-owned
children: owning the parent permits replacement of any child entry. Keep the
`forge-ownership.test.mjs` adversarial fixtures in the scoped gate. Its required
Linux test uses actual distinct UIDs through passwordless python sudo to attempt
work/container replacement during prepare and checks the other slot's ownership;
macOS cannot establish that cross-identity proof and skips it explicitly.

Git gates receive hash-bound logical Mac HEAD and per-entry `tracked` evidence
from Mac `git ls-files` in manifest v2. Older manifests (including warm bases)
are refused; rebuild bases or use local/full shipping rather than infer tracking.
Forge fetches current `origin/main` and the exact manifest-bound Mac HEAD from
the fixed public HTTPS origin with a credential-free environment, even when
that object is already cached. Its detached HEAD must equal the Mac SHA. It
stages exact tracked snapshot bytes and deletions, leaves Mac untracked leaves
untracked, and creates no snapshot commit. Unfetchable/unpublished HEAD or failed
Git setup returns protected `started:false`, `reason:git-head-unavailable` evidence;
the client falls back through Mac admission without retrying remote execution.
The separately installed wrapper advertises `gitWorktree:2`; clients refuse v1
(the historical base-HEAD behavior) before rsync and use local admission.
Snapshot inventory pins deletion evidence to that HEAD and refuses HEAD drift
before prepare. A warm base only saves hash-verified file transfers and dependency
work; its SHA/ancestry never defines Git scope. Pin both real guards
(`scanDiffBranchCoverage` and `validateUntrackedDerivedArtifacts`) against
materialized local-bare-origin fixtures, including Mac HEAD behind public main
with working tier bytes equal to main, both full and delta shipping, unavailable
HEAD, and Git setup failures with cached objects. Replace only public transport
in hermetic tests; never contact a developer remote or the network.
No Mac Git configuration, credentials, or verification marker path crosses SSH.
Verification marker authorship stays in the Mac gate driver and requires a
confirmed protected receipt. Run the scoped Forge tests through heavy-admission;
never execute setup in a development lane.

The run-scoped temp allocator canonicalizes its base before creating fixtures: macOS's
`/var` alias must not reach descriptor-relative snapshot copies, which reject symlink
ancestors. Preserve those production no-follow guards; test the allocator with an explicit
symlink alias rather than teaching the copy code to follow links.

Warm manifest reuse requires conservative Git stat evidence: disabled `core.trustctime`,
`core.checkStat=minimal`, or enabled `core.fsmonitor` (including a hook path) requires
`full-scan`. Unreadable or incomplete config evidence also requires that fallback.
Use `git ls-files -f -v -z` for index flags: fsmonitor-valid entries become lowercase
only with `-f` and must be hashed. The fast-manifest tests pin restored-mtime edits
and fsmonitor-valid entries; the offload tests require every final leaf to be read
and hashed when reuse is unavailable.

Git metadata setup runs entirely under an operator-owned 0700 temporary parent;
publish `.git` only after the final privileged Git command. A root-owned `.git`
under worker-owned `work` can still be renamed and replaced by that worker.
Never run privileged Git in `work`, or trust it through `safe.directory`; trust
only the protected clone and warm mirror, and disable `core.fsmonitor` as well
as hooks. The ownership tests substitute a real executable fsmonitor repository
at `update-index` and include a positive payload control. A required Linux test
uses root and an actual worker UID, proving that UID cannot reach the protected
metadata and its substituted config never executes as root; macOS skips this
cross-UID proof explicitly. Cross-UID fixtures that use absolute worker paths
must have traversable ancestors: changing only the fixture root's mode does not
grant traversal through Vitest's private 0700 run root. Allocate those Linux
fixtures under the system shared temporary directory with a privileged
`TemporaryDirectory` supervisor that cleans up on success, failure and child
timeout; keep shared ancestor permissions unchanged. The executable fsmonitor
positive control must still run as the actual worker UID before the attack.
Exercise Git's ownership checks with
`GIT_TEST_ASSUME_DIFFERENT_OWNER` and a mirror with only `origin/main`
(an unborn bare `HEAD` is normal for the warmer). Active base pins must remain
ops-owned and readable by the ops warmer even when the pool wrapper creates them
as root; pin creation and ownership changes stay inside the shared base guard.
### Single-pid process identity evidence

`scripts/lib/proc-identity.mjs` exposes `record` (canonical, null-free identity capture)
and `probe` (positive-evidence tri-state checks). UID remains a captured filter, not
a key for `probe`; legacy `liveness` and `sameIdentity` retain their UID comparison.
Live-process fixtures must supply Linux cmdline and namespace links as well as stat/status.
For an exited Linux leader, `probe` uses stat plus a bounded task census without reading
the namespace link (which can disappear at exit): all exited tasks plus an unchanged
task-ID set in a final census prove dead; any live task yields `unknown` with
`zombie-leader-live-tasks`. Changed, duplicate, unreadable, incomplete or over-budget
censuses yield `unknown` with `evidence-unavailable`; retry or inspect manually.
An initial task-directory `ENOENT`/`ESRCH` can also mean hidepid concealed live workers:
require independent absence confirmation (readable boot ID and signal-zero `ESRCH`)
before returning dead. Test both directory errors with signal-zero success, `EPERM`,
`EACCES`, and other failures (unknown), alongside confirmed absence (dead).
Race fixtures must include a worker spawning a live successor before its own stat is
read as Z/X/x, and a same-count task replacement. Reordering an unchanged set must
still permit dead. `record` still requires the namespace
link to capture a complete identity. Model removed evidence with a read error, not
an empty successful output or ENOENT: those can be positive absence evidence. Exhaustive
subset tests cover both absence and exited-task death as well as live and reused keys.
Race fixtures must change the second per-PID stat read: a changed start time or parent
PID makes `record` fail and `probe` return `unknown`, both with
`identity-changed-during-read`. Exercise each field separately and together so removing
either comparison is detectable. A second-read transition to Z/X/x keeps the captured
identity recordable when evidence is complete; `probe` must consult the task census,
returning dead for all exited tasks or unknown for a live task, never alive.
Linux `listGroup` fixtures must also provide `/proc/self/mountinfo`: a visible leader
does not prove that procfs exposes other users' group members. Require one full procfs
mount at `/proc`, with hidepid absent or explicitly zero, and unchanged mount evidence
before and after the census. Hidden, missing, malformed, unreadable or oversized mount
evidence yields unknown; retry or inspect the mount configuration manually. Keep a
visible-leader/hidden-member regression alongside the omitted-leader case.
The real-host cases require permission to execute `ps` and read the boot UUID on macOS;
a sandbox denying either operation produces unknown and cannot certify those cases.
