---
bornAs: xprg7e1
kind: story
size: 5
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-lease.mjs", "we:scripts/lib/__tests__/lane-lease.test.mjs", "we:scripts/__tests__/lane-pool-reap-dead-owner.test.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Reap lane leases whose owner is dead, using a durable owner pid

we:scripts/lane-pool.mjs lease pid is the short-lived acquire process, so pid-liveness cannot prove the owner is gone. Record a durable owner pid (the long-lived worker/session process) in the lease and have we:scripts/lane-pool.mjs reapDeadLeasesInPool reap leases whose owner pid is dead on this host. Seen 2026-10-28: coordinator hand-released 4 leaked leases, one 3 h old. Must keep exclusivity: never reap a live owner; fail closed when the pid is unreadable.

## Acceptance

- [A1] **Executable** — add `we:scripts/__tests__/lane-pool-reap-dead-owner.test.mjs`; run `npm run test:unit` through heavy-admission with `we:scripts/__tests__/lane-pool-reap-dead-owner.test.mjs` as its file argument. A same-host dead durable owner must be reaped before TTL expiry; the test must fail against the current acquire-process pid lease model.
- [A2] **Must refuse** — never reap a live owner, an unreadable/invalid owner pid, an owner on another host, or an owner whose process identity cannot be verified. Log the refusal so an operator can inspect and explicitly release a verified abandoned lease.
- [A3] **Must preserve** — apply the same ownership checks regardless of whether the session works on source, docs, config, or data; a lane's contents cannot authorize lease removal.
- [A4] **Executable** — the same test file must cover a live worker after its acquire child exits, dead worker reclamation, unreadable/truncated metadata, pid reuse, and a replacement lease appearing before deletion.

## Test plan

These are planned cases in `we:scripts/__tests__/lane-pool-reap-dead-owner.test.mjs`, not claims of existing coverage. Run them through the A1 heavy-admission command; use real local worker/acquire children for lifecycle cases and injected process probes and deletion barriers for deterministic error/race cases. Keep all leases younger than TTL so expiry cannot mask an ownership error.

| Case name | Acceptance / edge | Observable assertions |
| --- | --- | --- |
| `reaps a proven dead same-host durable owner before TTL` | A1, A4 | Start a worker that acquires a lease, terminate and wait for that worker, then reap. Assert the recorded owner pid/start identity belonged to the worker, the lease is removed before TTL, and a new acquire succeeds. This case must fail against the acquire-process pid model. |
| `retains a live worker after its acquire child exits` | A2, A4 | Wait for the acquire child to exit while the durable worker remains alive. Reap and assert the lease bytes and holder are unchanged, a competing acquire is refused, and refusal diagnostics identify the live-owner reason and inspection/manual-release fallback. |
| `refuses foreign-host ownership without a local pid probe` | A2, identity scoping | Supply another host with a locally dead-looking pid. Assert zero local liveness/start-identity probes for it, zero removals, unchanged lease bytes, and a foreign-host refusal diagnostic with the operator fallback. |
| `retains unreadable invalid or incomplete ownership evidence` | A2, A4, truncated reads | Parameterize unreadable lease, truncated JSON, missing pid, non-positive/non-integer pid, missing start identity and legacy acquire-only metadata. Assert zero removals, existing readable bytes unchanged, competing acquisition refused, and a reason-specific refusal diagnostic with the operator fallback for each input. |
| `retains ownership when process identity is unverifiable` | A2, fail closed | Inject permission-denied and unknown liveness/start-identity probe results. Assert no removal or successful competing acquire and diagnostics distinguishing unavailable evidence from proven death, with inspection/manual-release guidance. |
| `refuses pid reuse and inconsistent owner evidence` | A2, A4, who wrote it | Return a live process with the recorded pid but a different start identity; also supply forged session ownership inconsistent with writer-recorded evidence. Assert unchanged lease/holder, zero removals and an identity-mismatch diagnostic with the operator fallback. |
| `preserves a replacement lease during reaping` | A4, shared state | Pause after dead-owner evaluation, replace the lease with a live holder, then resume deletion. Assert the replacement bytes/holder survive and a competing acquire is refused. |
| `ownership checks are independent of task content` | A3 | Parameterize source, docs, config and data tasks, each with a proven dead owner and a live/unverifiable owner. Assert identical reaping decisions across kinds: only proven dead ownership is removed, while protected leases remain byte-identical and produce refusal diagnostics. |
| `treats hostile metadata as inert data` | A2, untrusted text | Supply session/host strings containing shell syntax and control characters plus malformed identity fields. Assert no shell execution or sentinel creation, no removal based on those strings, and terminal-safe refusal diagnostics. |

## Risks

- Reaping a live or different worker breaks exclusivity. The live-worker, foreign-host, unverifiable-identity, pid-reuse and replacement-lease cases above must fail if their corresponding ownership guard is removed.
- Mistaking an acquire child's exit for worker death loses active work; failing to record durable identity leaves leaks until expiry. The two real lifecycle cases distinguish these outcomes without waiting for TTL.
- Silent fail-closed refusals leave operators unable to recover capacity. Every refusal case asserts its reason and the inspection/manual-release fallback; remove diagnostic emission as a planned mutation and require those assertions to fail.
- Content or forged session text could accidentally bypass ownership checks. The task-content matrix and hostile/inconsistent metadata cases assert the same protection across all task kinds. No test in this plan authorizes automatic reclamation when evidence remains unknown.

## Non-goals

- [N1] No remote-host process probing, TTL policy changes, live-owner eviction, or retroactive inference of durable ownership for legacy leases. Keep existing conservative expiry/manual release paths for unverifiable owners.
- [N2] No HTTP receive/write endpoint is introduced; body-size limits, request rate limits, CSRF/origin checks do not apply. Lease removal remains scoped to the existing local reaper and its ownership checks.

## Edge cases this change must handle

1. **Untrusted text** — parse lease metadata as data; never execute session/host strings or interpolate them into shell commands. Reject malformed pid and identity fields.
2. **Truncated reads** — incomplete JSON or missing ownership evidence leaves the lease untouched and reports the refusal.
3. **Shared state files** — revalidate the exact lease identity before removal; a concurrent replacement must survive, with acquisition exclusivity preserved.
4. **Fail closed** — unreadable pid/process evidence, permission errors, and unknown liveness retain the lease; direct the operator to inspect and explicitly release it.
5. **Identity scoping** — only prove death for a same-host durable owner; record process-start identity with pid so a reused pid cannot identify a different worker as the owner.
6. **State over time** — the short-lived acquire process exiting never proves owner death; a live durable owner is never reaped, and pid reuse or legacy missing fields follow the conservative fallback.
7. **Who wrote it** — only the lease writer records the durable worker identity; caller-provided session text is not proof. Preserve holder identity checks and reject forged/inconsistent owner evidence.
