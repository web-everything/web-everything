---
bornAs: xmh9mtr
kind: story
size: 2
status: active
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/readiness/__tests__/heavy-admission-fast-lane.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Heavy-admission durations log records external (Codex/agy) build holds with a blank session

Hold identity is read from the lane lease at slot RELEASE; probation (Codex/agy) build lanes are reaped pr-merged seconds after acquire, so every hold records no session/dispatchKind. Capture identity at ACQUIRE (env WE_HEAVY_SESSION/WE_HEAVY_DISPATCH_KIND from probation-build-run, else the lease then).

## Evidence

Live `durations.jsonl` (2026-10-08): lane-12 acquired by `conveyor-4420` (probation-test-fix-build) at 05:27:22Z,
lease reaped `pr-merged` at 05:27:24Z; the worker's `vitest`/`check:standards` holds (05:27:43Z, 05:31:17Z) carry
no `session`/`dispatchKind`. 192 of 1353 log lines are session-less, all the same shape (lease gone or replaced
by release time).

## Done when

1. **Executable** — `npx vitest run we:scripts/readiness/__tests__/heavy-admission-fast-lane.test.mjs -t 'identity at acquire'`
   fails before (session read at release → missing) and passes after.
2. A hold acquired with `WE_HEAVY_SESSION`/`WE_HEAVY_DISPATCH_KIND` set records them even if no lease exists at release.
3. Without env, the lane lease read at ACQUIRE wins over whatever lease (or none) exists at release.
4. `probation-build-run` sets both env vars (session = dispatch session slug, kind build|prepare, plus run id) for the worker and gate.

## Edge cases this change must handle

1. **Untrusted text** — env values are clipped to 200 chars and stored as JSON strings only.
2. **Truncated reads** — n/a: lease read is the existing best-effort JSON parse; failure → fall back.
3. **Shared state files** — n/a: same append path as today; only extra fields in the slot meta.
4. **Fail closed** — identity is metadata only; any failure leaves the field absent, never blocks admission.
5. **Identity scoping** — acquire-time identity is the holder's own; a later lease on the same lane can no longer mis-attribute.
6. **State over time** — older slot entries without meta identity still fall back to the release-time lease.
7. **Who wrote it** — n/a: no authorship decision.
