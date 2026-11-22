FlowEngine/v0 is a shadow-only, read/plan interface. Consumers import `index.mjs`.
`load` returns an immutable definition and RFC 8785 SHA-256 digest. `plan` requires
`{flowDigest, seq, records, event, outcome, parts, attempt?}`; records are contiguous
interim Transitions through seq (later records are ignored). Guard results, time,
claims and leases belong to existing actors. No guard code is evaluated here.
Planned steps and Transition predicates carry `attempt` (default 1). Retry attempts
share the declared visit and key; replay deduplicates by `(key, attempt)`. Historical
records without `attempt` count as attempt 1; malformed or over-bound attempts are
refused. The declared retry bound applies even when the final attempt succeeds.
Missing evidence is refused; operators supply a complete projection rather than
treating refusal as approval. Retry exhaustion is reported to the actor with the
declared exhaustion target. Unknown retains its declared non-advance route/target.

The v0 legacy shape requires the explicit `keys` and per-step `key` extension from
v0.1. No keys are synthesized. Modern definitions validate against flow/definition
v0.1 and all eleven definition rules. Legacy definitions validate against the
decision-lifecycle schema (flowType pin removed per design §1.4), its soundness,
approval and retry rules, plus declared-key/cycle and expression checks. Timers,
compensation, sub-flows and nested states are refused with a core/plug loss report.
Thus the full design example with a deadline is deliberately refused, not truncated.

`reference/` snapshots Standards handoff `drafts/flow/definition/v0.1/rules.mjs`
and `drafts/tools/flow-rules.mjs` on 2026-11-22. `schemas.json` is the lossless
reference closure of definition, decision-lifecycle and core/plug loss-report
schemas: only reference names were relocated into local `$defs`. There is no
runtime dependency on another checkout. The legacy keys extension is explicit in
`load.mjs`. Reference code is validation only, not another executor.

The review daemon's detached job calls the shadow beside its durable completion
in `scripts/operations/review-job-envelope.mjs`. Set `WE_FLOW_V0_SHADOW_FILE` to an
operator-prepared JSON file containing `{definition, projection, ctx, logPath}`.
`ctx` carries repo, pr, head, netDiff, executorCommit, seq, at and input record ids.
Keep the projection independent of the observed completion and pinned to that PR
round. Input over 256 KiB is refused with an operator diagnostic. Append is best
effort, asynchronous and append-only; it never changes a returned worker/merge
outcome. The legacy comparison currently recognizes convergence accept/continue;
other observed words are unknown and disagreement is reported conservatively.
No default path, external read, GitHub call or deployment is introduced.

`comparePlans` requires canonical byte equality for replacement engines; any
difference blocks retirement and returns a finding. Live acceptance still requires
three real PR rounds after an operator enables the hook; unit fixtures are not
live proof. The log timestamps and executor commit are supplied by the caller.

The P8 hotpatch definition lives at `scripts/conveyor/flows/hotpatch/flow.json`.
It uses the decision-lifecycle subset: judges name intake, pinned, ready, loaded
and live evidence; the adapter performs pin, audit, load and unload. Waiting
evidence cannot advance, and unknown routes escalate without advancing.
`scripts/hot-patch.mjs request <pr> --daemon=<key>` opens an immutable-head run;
`status <pr>` reads its journal. Completed B01 Transitions alone enter replay;
intent rows precede effects and never count as completed registration. Recovery
rechecks ready and the overlay list before retrying an interrupted add. The
adapter uses the existing guarded overlay-add path, leaving adoption to the daemon.
The exported runner tick is for P8-d wiring; this slice installs no scheduler.
