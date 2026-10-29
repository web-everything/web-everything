---
bornAs: xsewwno
kind: story
size: 3
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run-acquire-contention.test.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Fix daemon must not count lane-acquire contention as a fix attempt

we:scripts/operations/fix-run.mjs runs lane-pool acquire --wait-ms and a 'no lane within Nms (lock contention)' or exit-75 failure is counted as a fix attempt (hit #6017, #6023, #6035, #6046 on 2026-10-28). Treat lane-pool acquire exit 75 and lock-contention failures as environmental: retry with backoff inside the run, never increment the attempt counter. Prove on a live contended acquire.

## Acceptance

- [A1] **Executable** — add `we:scripts/operations/__tests__/fix-run-acquire-contention.test.mjs`; run `npm run test:unit` through heavy-admission with `we:scripts/operations/__tests__/fix-run-acquire-contention.test.mjs` as its file argument. A contended acquire followed by success must leave the persisted attempt count unchanged until a fixer actually starts; this must fail against the current attempt-counting behavior.
- [A2] **Must refuse** — ordinary exit 1, signals, timeouts, malformed output, and unknown acquire failures remain failures; lane-hold wording alone cannot authorize an environmental retry. Test an explicit verified lock-contention diagnostic separately from arbitrary stderr text.
- [A3] **Must preserve** — source, docs, config, and data tasks all keep their validation and failure handling; environmental classification only changes pre-fixer lane acquisition accounting.
- [A4] **Executable** — test repeated exit 75 and verified lock contention with bounded backoff, a finite retry deadline and cancellation; exhaustion reports an environmental deferral for a later daemon tick without spending an attempt. Prove a real contended acquire in a throwaway pool through the same test command, with no fixer started while contention persists.

## Test plan

These are planned cases in `we:scripts/operations/__tests__/fix-run-acquire-contention.test.mjs`, not claims of existing coverage. Run them through the A1 heavy-admission command. Inject clock/backoff, acquire outcomes and fixer startup for deterministic assertions; use a temporary persisted run store for restart/concurrency cases and one real throwaway pool for the live contention case.

| Case name | Acceptance / edge | Observable assertions |
| --- | --- | --- |
| `contention then success counts only the started fixer` | A1 | Return exit 75, verified lock contention, then a valid lease. Assert persisted attempts unchanged after each acquire failure and after acquire success until fixer startup, no fixer before success, then exactly one startup and one attempt increment. This case must fail against current attempt accounting. |
| `ordinary and unknown acquire failures remain failures` | A2 | Parameterize ordinary exit 1, signal, timeout, unknown status and 75 accompanied by a signal. Assert failure, zero environmental retries, zero fixer starts and no success/deferral result; include lane-hold wording in stderr to prove it cannot authorize retry. |
| `malformed acquire output never starts a fixer` | A2, truncated reads | Parameterize successful exit with invalid/truncated JSON, missing/invalid lane identity and incomplete lease evidence. Assert failure, zero environmental retries, zero fixer starts and no inferred successful acquisition. |
| `only verified lock contention permits retry` | A2, untrusted text | Compare a diagnostic verified as this acquire's lock contention with arbitrary or truncated stderr and foreign-session diagnostics containing similar wording. Assert only the verified result schedules backoff; others fail without retry or fixer startup. Hostile text must execute no command or create a sentinel. |
| `preserves validation across task kinds` | A3 | Parameterize source, docs, config and data tasks. For each, use valid and invalid task inputs and a post-start validation failure. Assert invalid input keeps its existing refusal, valid input retains every existing validation call/result after environmental retry, and post-start failure remains a counted failure with no attempt refund. |
| `repeated environmental failures defer at the finite deadline` | A4, bounded cost | Parameterize repeated 75 and repeated verified lock contention. Advance an injected clock through the configured backoff/deadline, asserting positive bounded delays, no acquire after the deadline, unchanged persisted attempts, zero fixer starts and an explicit environmental deferral for a later tick/operator inspection. Extend failures beyond the retry budget to exercise exhaustion. |
| `cancellation stops acquisition and backoff` | A4, state over time | Cancel while waiting in backoff and while acquire is in flight. Assert pending wait/child cancellation, no later acquire or fixer startup, unchanged persisted attempts and a cancellation result rather than success. |
| `restart preserves attempts after repeated contention` | A1, A4, state over time | Seed a nonzero persisted attempt count, encounter contention, reconstruct the runner from the same store, then contend again and eventually succeed. Assert the original count survives both runners unchanged until exactly one fixer starts and increments it once. |
| `concurrent ticks serialize fixer startup and accounting` | A1, shared state | Race two ticks for the same run behind a deterministic barrier. Assert only the existing state writer mutates the counter, exactly one fixer starts/increments, and the other tick neither duplicates startup nor resets persisted attempts. |
| `retries stay scoped to the current run` | A1, identity scoping / who wrote it | Seed another repo/session/item with a live lease and a distinct attempt count; retry this run with hostile task text and foreign child diagnostics. Assert the other lease/count stay byte-identical, no foreign release occurs and only this run's acquire result can permit startup. |
| `real pool contention defers without spending an attempt` | A4 | Hold a real throwaway pool's scan lock with a live fixture owner and run bounded acquisition through the runner. Assert observed real contention, no fixer while it persists, unchanged persisted attempts and environmental deferral at the deadline. Confirm the foreign lock/lease remains unchanged and fixture cleanup releases only its own state. |

## Risks

- A broad environmental classifier can hide real failures or start a fixer without a lease. The ordinary/unknown failure, malformed-output and verified-diagnostic cases must fail if those refusal checks are removed.
- Retry storms can exhaust host capacity or ignore cancellation. The deadline and cancellation cases assert bounded child count/backoff and no work after exhaustion/cancellation; planned mutations remove the deadline or cancellation check and must fail these cases.
- Restart or concurrent ticks can spend attempts without doing work, reset prior history or start duplicate fixers. The startup-accounting, restart, concurrent-tick and real-contention cases assert persisted counters and actual startup counts; incrementing on contention must fail them.
- Environmental handling could skip validation or touch another run. The task-kind validation matrix and run-scoping cases assert preserved validation failures and unchanged foreign state; neither permits refunding an attempt once a fixer has started.

## Non-goals

- [N1] No attempt refunds after a fixer starts, lane-pool exit-code changes, unbounded retries, live-lease eviction, or broad classification of all acquire failures as environmental.
- [N2] No HTTP receive/write endpoint is introduced; body-size caps, request rate limits, and CSRF/origin checks do not apply. Backoff and the finite acquisition deadline bound local retry cost and prevent state-resetting retry storms.

## Edge cases this change must handle

1. **Untrusted text** — stderr and task text are data; use exit status plus a verified contention diagnostic, never arbitrary lane-hold wording, to classify retry eligibility.
2. **Truncated reads** — incomplete acquire JSON or truncated/missing contention evidence fails closed; no lane or successful fixer start is inferred.
3. **Shared state files** — preserve persisted attempt counters across retries and serialize updates through the existing run-state writer; concurrent ticks must not launch duplicate fixers.
4. **Fail closed** — unknown errors, signals, and timeouts remain visible failures; a retry deadline reports environmental deferral for operator inspection or a later tick, never a successful fix.
5. **Identity scoping** — retry only acquisition for this run's repo/session/item; never release another holder's lease or modify another item's attempt count.
6. **State over time** — repeated contention and daemon restart must not consume attempts; cancellation stops retrying, and successful acquire permits exactly one attempt increment when the fixer starts.
7. **Who wrote it** — only the current run's acquire child supplies status/diagnostics; persisted counters remain owned by the run-state writer, never rewritten from task text or foreign session output.
