## Lane lease heartbeat safety probes

Keep the lazy heartbeat import in `codex-direct-task.mjs`: widening its static
import graph has hung the repeated CLI calls in `sibling-clone-provision.test.mjs`.
The wrapper waits for child readiness before entering task code; startup failure
must leave the task callback untouched. A plain checkout with no marker is allowed.

Use a real Node subprocess with a short TTL and `Atomics.wait` to prove renewal
continues while the parent event loop is blocked. An injected interval alone cannot
prove that guarantee. A separate process test removes the lease while the parent
is blocked and uses a worker ignoring SIGTERM to exercise SIGKILL escalation.
The guardian owns escalation so parent death or IPC disconnect cannot cancel it.
Arm escalation before sending loss notification: the parent can exit in its onLost
handler before the guardian signals it. Keep a deterministic FIFO subprocess test
that reaps the parent on notification, then releases the guardian to exercise ESRCH
and verifies the resistant worker exits via SIGKILL.

Ownership tests must include a conflicting declared worker despite a matching
holder, ambiguous ownerSession across live sibling lanes, and missing explicit
owner/caller evidence. Renewal callers pass both identities, including soak fixtures.
All writers share the mutation lock, and reacquisition re-reads and validates its
snapshot inside that lock before publishing. Keep process fixtures bounded and
run scoped suites through heavy-admission.

When instrumenting native Node with a data-URL preload, match stack frame prefixes,
not substring occurrence: the data URL itself contains the preload source, so a
substring test can mistakenly claim a protected call frame exists.
