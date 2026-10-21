---
bornAs: x3mfxzv
size: 13
kind: story
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs", "we:skills-src/conveyor/review-refill.mjs", "we:skills-src/conveyor/__tests__/review-refill.test.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs", "we:scripts/settings/review-refill.json"]
dateOpened: "2026-10-20"
tags: []
---

# Refill review and fix slots on job completion (event-driven), not only at the next daemon pass

Review and fix loops await a full pass and then sleep; completion does not wake a replacement dispatch. Add a shared, debounced completion refill that consumes the last successful pass's ordered queue, revalidates candidates through the existing eligibility/cap checks, and shares a dispatch lock with the full pass. Deliver shadow first, with standard-off review/fix settings and source logging; enable actual dispatch only after the shadow evidence is reviewed. An off-branch review-only prototype exists at `64ebf2c072`; it is a starting point, not evidence that review and fix refill are integrated here.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/review-refill.test.mjs` — add fake-clock cases for both review and fix: a tracked job completes, 15 seconds coalesce duplicate notifications, and one eligible replacement is selected before the next full pass. This regression fails before the refill is integrated; it must assert the dispatch call in enabled mode, not just a shadow log.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/review-daemon.test.mjs` and `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/reconcile-fix-dispatch-daemon.test.mjs` — race pass/refill and two completions; assert one dispatch per repo/PR/head, live cap and acquirable-lane limits respected, no dispatch after lease loss, and identical priority/eligibility to a normal pass.
- [A3] Shadow mode must perform no reconcile mutation, claim, lane acquisition or dispatch. Drop aborted/partial pass queues; revalidate head, open state and eligibility before a live refill. Busy lock, stale queue or failed read skips refill and leaves the periodic pass responsible.
- [A4] Record a full day of shadow selections versus actual dispatch timestamps, with matched repo/PR/head and idle-slot minutes. At unchanged caps, an enabled trial must show reduced idle time without duplicate launches; simulation alone does not graduate the prototype.
- [A5] Resolve `review.refillOnCompletion` and `fix.refillOnCompletion` as off/shadow/on through the shared settings cascade, log value/source, and observe runtime changes without restarting once the runtime layer is identified.

## Non-goals

- [N1] Do not change priority, eligibility, caps or drain enqueue behavior.
- [N2] Do not infer completion from arbitrary log prose or replace the periodic recovery pass.

## Edge cases this change must handle

1. **Untrusted text** — Validate structured job identifiers; never execute event text.
2. **Truncated reads** — Incomplete completion/PR/process reads skip refill, never imply a free slot.
3. **Shared state files** — Use the same dispatch mutex for pass and refill; re-read capacity under it.
4. **Fail closed** — Unknown eligibility, unavailable state or lost daemon lease means no dispatch.
5. **Identity scoping** — Key queues and deduplication by repo, PR, head and job identity; one repo cannot consume another repo’s event.
6. **State over time** — Coalesce for 15 seconds, expire old queues, discard aborted passes and invalidate changed heads.
7. **Who wrote it** — Accept only tracked jobs/process identities; shadow logs are evidence, not authority to dispatch.

## Grounding

- we:skills-src/conveyor/review-daemon.mjs:174 awaits the tick; line 182 sleeps afterward.
- we:skills-src/conveyor/review-daemon.mjs:379 exposes the existing onPlan callback.
- we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:145 awaits its tick before subsequent iterations.
- At commit `64ebf2c072`, we:skills-src/conveyor/review-refill.mjs:7 describes cached-pass queues; line 23 says on behaves as shadow and line 35 says the daemon hook is not yet applied. This file is absent from this checkout.
- Size 13 covers two daemon integrations, shared refill, settings and concurrency tests plus live evidence; it exceeds a single small patch.

## Open questions

Which runtime-settings implementation is the prerequisite named in the original card? Repository searches found no separately named card for it, so no guessed blockedBy edge is added. Options: identify and reuse that build, or add runtime settings here. **Pick: identify/reuse it.** Slice seams: review shadow integration, fix shadow integration, then shared enabled dispatch and live graduation; preserve the full acceptance across those slices.
