## Established-overlay auto-rebase

Operator withdrawal wins over a detached repair: the worker rechecks its source registration
before push, then `addOverlay` compares the same snapshot under the overlay list mutex before
registering a replacement. An absent, changed (including a new `addedAt`) or corrupt source refuses registration,
creates no pending swap and reports `auto-rebase-needs-you`. A removal during push can leave an
unregistered remote branch; it never authorizes loading that branch. Unrelated list edits are preserved.
The `operator withdrawal during detached repair` tests cover each async phase and the final write boundary;
the `auto-rebase-operator-withdrawal` soak scenario uses the real removal CLI with injected Git and agents.
All three registration guards share `registrationIdentity`: cached `stackBases` rewrites do not change
operator intent, while every other field still participates in the comparison. Worker regressions rewrite
the cache during audit and at registration, then exercise adoption cleanup.
Pending evidence is persisted before replacement registration. Write or rename failure leaves only the
original registration; a rejected registration removes its pending file. An interruption between persistence
and registration leaves evidence for cleanup to escalate safely. The persistence regressions also retry the repair.
Under Vitest, `prepareRebuild` defaults auto-rebase to off without mutating the caller's environment;
tests exercising worker launch or pending cleanup must explicitly set `WE_DAEMON_AUTO_REBASE=1`.

The detached worker in `scripts/lib/daemon-rebuild/auto-rebase.mjs` merges main into a new
`<ref>-auto-<n>` branch so ancestry preserves the original tip. It retains the old registration
until the verified adopted HEAD contains the replacement SHA and the replacement contains a freshly
fetched origin tip of the old ref. An advanced or unreadable old tip retains both registrations and
escalates through `auto-rebase-needs-you`. Cleanup requires the replacement's freshly fetched origin
tip to contain the pending SHA, and `removeOverlay`'s `requireRef` checks the replacement is still
registered under the same list mutex that removes the original, so a withdrawal up to that write wins;
its `expectedOverlay` is the original's registration recorded in the pending file at swap time (never a
fresh read), so an original re-registered at any point since is never removed, on that pass or a later
one; a pending file without it fails closed. A replacement
unregistered before adoption escalates every cleanup pass instead of waiting silently;
the pending file stays, so a fresh repair is the operator's call;
missing or unreadable evidence retains the old registration and pending file and alerts in both sinks.
A mechanism-pinned original is never set aside as stack-contained, so the plan still lists it as lost
beside its applied repair. `prepareRebuild` does not hold for a lost overlay whose current tip the
build contains (git ancestry; an unreadable answer still holds), so the repair can be adopted and cleaned up.
In tops mode, deferring a pinned base behind its containing overlays requires proof that its exact
registered tip is already in the running HEAD and in each containing overlay's tip. Missing HEAD,
non-containment or unreadable ancestry preserves ordinary pin handling. The stack-tops regressions
cover those closed paths. Deferral also requires an unresolved conflict at the base's ordinary position against
the accumulated build. A clean base retains its position: applying it can make a containing top
merge cleanly even when that top conflicts directly with main because of a newer merge base.
The clean-base regressions cover explicit and mechanism pins, including a preceding overlay that
makes the base clean; `pinned-stack-clean-base-order` replays adoption through the daemon soak harness.
Each conflicting base can be deferred only once; failed tops return it to ordinary pin handling.
Reviewed edge resolution runs before deferral, and an unreadable merge cannot authorize reordering.
Edge-resolved rebuilds retain the registered overlay tip as their second parent and the approved edge tip
as a third parent. Copying only its tree loses ancestry when a later overlay has identical content.
History readers accept both merge shapes; ready-build verification allows only the approved edge as the
extra parent, still checks current approval and content, and accepts persisted two-parent builds.
Registered auto-rebase repairs do not trigger deferral; the mechanism-pinned
auto-rebase cases preserve the original's conflict/loss decision, repair adoption and loss protection.
Per-ref JSON sidecars next to the overlay
list survive ticks; per-ref markers expire after 30 minutes without a heartbeat. Live detached
workers touch their own token's marker every minute with an unrefed interval, cleared in `finally`.
Long-running agents and tests use asynchronous child processes so they cannot starve that timer.
Test liveness past expiry with a fake clock and injected filesystem touch. Failed workers retain their
marker until expiry to bound retry cost. `WE_DAEMON_AUTO_REBASE=0` disables
new jobs and pending-swap cleanup. Cleanup follows interrupted-build recovery and requires
`state.adopted.head === HEAD`. Launch and pending-swap failures write both the needs-you event and alert.
Pending files are isolated: unreadable JSON, invalid swaps and failed removal retain the evidence
and leave later files eligible for cleanup. Unexpected scan failures also escalate from prepare.
Both Codex JSON reports must carry exit code zero, no timeout, and terminal `turn.completed`;
the wrapper process exiting zero alone is insufficient. The source of the switch is logged on consultation. Missing related tests, incomplete
reads, more than 100 selected tests, failed tests, or an audit without the exact verdict
`NOT WEAKENED` escalate through `auto-rebase-needs-you`; the old registration remains.
Select scoped tests from the completed candidate diff against the old tip as well as the
original conflict paths: the fixer can edit modules beyond those conflicts.
Git path listings use `-z` and split on NUL without trimming, so non-ASCII and whitespace
paths match the import graph in conflict, candidate-diff and overlay-branch selection.
The static reverse-import graph supplies scoped tests, so dynamic-only relationships require human intervention. Exercise both registration and adoption with real git in temporary repos;
Codex and the queued test runner stay fake in `daemon-rebuild-auto-rebase.test.mjs`.
The queued test run must also produce a fresh Vitest JSON report proving every selected file executed.
Load its inventory helper only during validation: its dependency graph needs npm packages, while
the copied-script backlog CLI fixtures intentionally boot without `node_modules`.
Exit zero alone is insufficient: a mixed selection can pass while the unit config excludes an integration
file. Missing, malformed, partial, oversized (over 8 MiB), or entirely skipped inventories stop before audit, push and registration
with `auto-rebase-needs-you`; verifying excluded tiers requires human review. The worker uses the shared
`alwaysRunInventory` check, compares paths against the scratch clone's real path, and removes its private
report on exit. The `auto-rebase executed-test inventory` regression includes a real Vitest exclusion probe;
the existing `auto-rebase-operator-withdrawal` soak break also exercises the omitted-file refusal.
Cleanup attempts both the private report and the scratch clone before rejecting a removal failure.
It emits one cleanup needs-you event and alert, including both reasons if both removals fail,
and retains the original registration and pending swap. The report/scratch/both cleanup cases
in `daemon-rebuild-auto-rebase.test.mjs` pin those guarantees.
The existing [test-selection fallback and durable evidence](../../../scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs) cases cover overlay tests, reverse imports, skipped empty runners and exact audit refusal.
Report and scratch cleanup are both attempted. A cleanup pass emits one needs-you incident containing
each removal failure; scratch cleanup failure still rejects the worker, while report-only failure remains
best-effort. The cleanup regression covers report-only, scratch-only and simultaneous failures.
Missing related tests fall back to overlay-branch tests plus import reach; fenced `noTestFiles` reaches the required audit, which must certify exactly `NOT WEAKENED`.
Selection rules and original conflict markers persist as JSONL evidence before tests; each conflict read and capture is capped at 65,536 bytes, with its descriptor closed in `finally`.
Evidence append failures stop at stage `tests` before tests, audit, push or registration; the needs-you event remains the fallback when the alerts file is unwritable.
Before test selection, list the candidate and both parent trees and require every parent's
`.test.*` or `.spec.*` JS/TS test path to remain at the same path in the candidate, including renames.
Any existing test removed by resolution requires human review at stage `tests`, even if other tests
remain or an auditor would certify the result. Unreadable tree listings also fail closed.
The `codex-audit-required` fallback covers genuinely uncovered files only; it cannot rescue deleted tests.
Capture skips non-regular files and platforms without `O_NOFOLLOW`; inspection, open and read failures remain best-effort omissions from evidence.

