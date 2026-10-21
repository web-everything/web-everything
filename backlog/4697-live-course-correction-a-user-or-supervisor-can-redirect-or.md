---
bornAs: x1jbzem
kind: story
size: 13
status: open
dateOpened: "2026-10-01"
tags: []
scope: ["we:scripts/operations/session-control.mjs", "we:scripts/operations/session-control-store.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/http-adapter.mjs", "we:scripts/operations/worker-wrapper.mjs", "we:scripts/operations/dispatch-abort.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/operations/__tests__/session-control.test.mjs", "we:scripts/operations/__tests__/worker-wrapper.test.mjs", "we:scripts/operations/__tests__/dispatch-abort.test.mjs"]
---

# Live course-correction: a user or supervisor can redirect or stop an ongoing agent session

A live fixer, builder or heal session needs an auditable redirect/stop channel instead of an informal cross-session message. Add a typed session-control operation backed by durable ordered requests, consumed at worker safe points with explicit acknowledgement. Stop preserves partial work and releases only the stopped session’s claims after termination is confirmed. Expose the same operation contract to operator and supervisor callers; redirect never grants review approval or broader permissions. Size 13 reflects the request store, adapters and lifecycle integration across three worker kinds; the product-surface boundary remains a question below.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/session-control.test.mjs` — a fixture submits a redirect to an active run, observes one delivery at its next safe point and a durable comply-or-stop acknowledgement. The new test fails while there is no session-control operation. Duplicate request IDs produce one effect, and unauthorized senders cause no effect.
- [A2] A stop during a pending child call cancels that call through the existing termination path, confirms the target is gone, preserves its lane/diff and records a resumable partial-work reference before releasing its owned claim. Failed termination or save leaves an explicit held/error record and never reports completion.
- [A3] Exercise fixer, builder and ci-heal launch paths with injected providers: new instructions supersede older pending redirects in recorded order; stop wins over redirect; an unacknowledged redirect prevents subsequent autonomous mutation until acknowledged or stopped.
- [A4] CLI and generated HTTP operation routes return request ID, target identity, accepted/pending/acknowledged state and refusal reason. Test actor authorization, bounded instruction size and stale-head/session refusal, including docs/config/data-only work.
- [A5] After the surface choice below, prove the operator-facing entry can submit and observe a request against a sandbox session; a generated route alone is not evidence that a Plateau control exists.

## Non-goals

- [N1] No approval, review-label, gate bypass or scope-expansion authority is conveyed by redirect.
- [N2] No forced deletion/reset of partial work and no silent release of another run’s lane or claim.

## Edge cases this change must handle

1. **Untrusted text** — Treat instructions and reasons as bounded data; normalize display text, preserve raw audit evidence safely, and never interpolate them into shell syntax.
2. **Truncated reads** — Incomplete process listings, log tails or run records cannot prove termination or acknowledgement; return a named unknown/held state.
3. **Shared state files** — Use atomic writes plus per-run locking and compare-and-set request sequence/claim ownership for concurrent operator and supervisor submissions.
4. **Fail closed** — Authorization, persistence, delivery, acknowledgement and termination failures remain visible refusals; they never mean successful stop or permission to continue.
5. **Identity scoping** — Address repo, PR/item, head, run and provider session handle together; support hash and numbered items without matching another repo’s PR number.
6. **State over time** — Replay pending delivery after restart idempotently; retain acknowledgements, supersession and stop ordering, and reject requests for a replaced run.
7. **Who wrote it** — Authenticate the operator/supervisor at ingress; a worker’s acknowledgement cannot forge the issuing actor, grant approval or widen scope.

## Grounding

- we:scripts/operations/worker-wrapper.mjs:122 builds resume argv; :130 validates the per-session resume-request path, but these helpers do not constitute an audited redirect API.
- we:scripts/operations/dispatch-abort.mjs:140 stops a recorded effect; :154 closes it out and :157 leaves lane release as a manual hint, so clean stop needs explicit preservation/ownership handling.
- we:scripts/conveyor/fix-procedure.mjs:708 owns fix-end and :735 releases the identity-bound fix claim.
- we:scripts/conveyor/reconcile-fix-dispatch.mjs:107 imports stopSession; :963 claims before resuming to prevent duplicate sessions.
- we:scripts/operations/http-adapter.mjs:24 documents generated operation routes; we:scripts/operations/run.mjs:173 is the registration seam.

## Open questions

Which delivery boundary should this size-13 story use: (a) WE operation/store and worker integration first, followed by a separately scoped Plateau control, or (b) one cross-repo delivery including the Plateau UI? **Pick (a)** so the backend contract and safe-stop proof are reviewable before UI wiring. Human confirmation is needed because the original ask explicitly includes Plateau. Slice seams: request/auth/store; worker delivery/acknowledgement; termination/preservation/claim release; Plateau control. The scope above predicts the WE files only; the Plateau caller must be located and added before choosing (b), not guessed.
