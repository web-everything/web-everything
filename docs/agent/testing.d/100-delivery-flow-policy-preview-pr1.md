## Delivery-flow policy preview (PR1)

`scripts/lib/delivery-flow.mjs` owns the standard class globs and ordered stage table.
`resolveDeliveryFlowPolicy()` uses the shared policy cascade: standard → platform →
repo `scripts/settings/delivery-flow.json` → JSON `WE_DELIVERY_FLOW`. Top-level keys
(including the classes object) replace whole; flows resolve per class through the
same cascade. Invalid stage lists drop only that class's value in that layer,
retaining the next valid lower layer. The required build/review spine is restored.
Protected classes (guard, merge, review, label, daemon) keep their standard order
and globs and require design; overlays can add globs or append new classes after
the protected prefix. A protected flow without design is invalid.
Only design accepts model, effort, timeoutMin and approve=false; other stages have
no setting consumer yet. Unsupported/unknown/empty or oversized scope selects guard;
narrow or repair the scope to recover its normal class. Unreadable layers retain
lower layers; an exception in the choke point returns the standard guard flow,
including design, and logs delivery-flow-unreadable once per failed call.

`node scripts/operations/run.mjs delivery-flow --scope=we:scripts/hooks/**` (or
`--num=<card>`, optionally `--json`) previews stages and provenance using compute
steps and memory-only run storage. It never executes stages. PR1 has no dispatch
consumer: the reader guard pins the only import to the show IO shell, reserving
dispatch-lane IO and the deliver-item wrapper for PR2. The delivery-flow*.test.mjs
suites cover all classes, mixed scopes, unsupported syntax and size bounds, cascade
replacement/provenance, invalid stages, mandatory spine restoration, reader failure,
and the real read-only CLI. Run them through the host heavy-admission queue.

Lease overlap intentionally retains an ancestor fallback for disjoint file/glob
pairs. Delivery classification refines `scopeEntriesOverlap` with the same module's
`globsMayIntersect` automaton; otherwise `scripts/**/merge-queue-*` captures
every scripts file. Keep both helpers shared; do not write another glob matcher.

### CI-held record resume budgets

CI-held record retries have two independent bounds: the label effect’s `unknownAttempts`
and the run’s `recordEffectResumeAttempts`. Project both through `reviewRunEvidence`
and check the shared `RESUME_MAX_ATTEMPTS` before planning a resume. Old raw runs without
a resume counter project zero; projections missing that evidence cannot prove eligibility.
Test the last eligible resume, exhaustion, and an exceeded budget against both the planner
and the driver; exhaustion must preserve the `review-unfinished` escalation. Explicit-resume
test argv must omit input flags (`--pr`, `--repo`), or parsing refuses before the replay guard.

Both saved counters must be non-negative safe integers. Only an absent raw run resume
counter defaults to zero; persisted null (including JSON-serialized NaN) is malformed.
Keep malformed CI-held evidence identifiable so explicit resumes also reach the shared
counter validator. Planner regressions must escalate `review-unfinished` without dispatch;
automatic and explicit driver probes must refuse without touching the run or label sink.

Automatic and explicit CI-held record resumes share one preparation guard: check both
retry budgets, re-read live acceptance clearance with `filed: true`, and force the label
sink’s strict CI gate even after timing settings change. Exercise both entry points with
revoked clearance and pending-to-green CI; refusal must leave the saved run untouched.

Persist `ciHeldRecord` before retrying the label effect: a subsequent pre-write refusal
(for example spawn EAGAIN) replaces its latest error. The saved provenance must keep
automatic discovery and explicit resume behind both guards and both retry budgets.
Exercise pending CI after timing settings change, revoked clearance, green completion,
and budget exhaustion after that intervening failure. Unknown pending outcomes remain
non-replayable; CI-held provenance does not establish that a write was never applied.

