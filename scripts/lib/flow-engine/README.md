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

The review job observes its durable completion through `shadowReviewStep`.
`reviewLoop.flowShadow` resolves standard → platform → tool → environment;
`scripts/settings/review-flow-shadow.json` declares enabled=true and file=null.
Null selects `<coordination dir>/flow-v0-shadow.jsonl` using the shared resolver.
`WE_FLOW_V0_SHADOW_FILE` overrides the log destination; it is no longer an input file.
Effective values and sources are logged. Disable with `flowShadow.enabled=false`.

The built-in `review-definition.mjs` describes only judge-convergence and its
accepted/parked outcomes. The conveyor job diagram is not a loadable definition.
Completion records supply observed outcomes and input ids; classified fields supply
head/netDiff/round/runId. Missing hashes skip observation, never synthesize hashes.
Round/runId may be explicitly unknown; executor commit comes from repository HEAD
or `WE_FLOW_V0_EXECUTOR_COMMIT`. Same-PR Transitions replay in contiguous sequence.
The interim engine refuses changed subject versions and terminal-state continuation;
these refusals require operator inspection, never modify production decisions.
Log reads are bounded at 256 KiB; archive an oversized log before retrying.
A shared nonwaiting lock protects replay/append, repeated completions are skipped,
and completion aliases and nonregular logs are refused. Append is best effort and
never enters the actual completion or merge result.

`comparePlans` requires canonical byte equality for replacement engines; any
difference blocks retirement and returns a finding. Live acceptance still requires
three real PR rounds after an operator enables the hook; unit fixtures are not
live proof. The log timestamps and executor commit are supplied by the caller.
