---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-gate.mjs", "we:scripts/__tests__/vitest-worker-cap.test.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/lib/cost-admission.mjs", "we:scripts/readiness/heavy-queue-projection.mjs", "we:scripts/lib/__tests__/resource-gate.test.mjs", "we:scripts/lib/__tests__/cost-admission.test.mjs", "we:scripts/readiness/__tests__/heavy-queue-projection.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add a property-style test over (floor, lowerBy, lowerMinimum) asserting that a lowered cap never… (from web-everything/web-everything#4814 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-gate.mjs:205` — Add a property-style test over (floor, lowerBy, lowerMinimum) asserting that a lowered cap never exceeds the floor. Fix: Math.min(floor, Math.max(lowerMinimum, floor - lowerBy)).
2. `we:scripts/__tests__/vitest-worker-cap.test.mjs:45` — Add a gate or test that we:vitest.shared.ts and resolveCap agree on the shared-pool path (no LANE_POOL_ROOT, env cap set), or have we:vitest.shared.ts read the same host-wide policy.
3. `we:scripts/readiness/__tests__/heavy-admission.test.mjs:1640` — Add a table-driven classification test through acquireSlotBlocking covering each IDENTITY_FIELD (purpose, session, holder, envSession) as the only matching source.
4. `we:scripts/lib/cost-admission.mjs:175` — Add a cut-over parity test per kind: for each legacy refusal (cpu floor, mem-free, load), assert that either `admit()` or the retained fact check still refuses. Review lens: any change that 'replaces' a gate lists each legacy refusal and the new check that covers it.
5. `we:scripts/readiness/heavy-queue-projection.mjs:525` — Verify P0 against the real main-red episode record (the owner session slug from `main-ci-red-core`) before honoring it, or at least cap the P0 hold with a P0 marker TTL, and add a test where a matching name with no open episode stays P3. Lint or review lens: any class derived from a caller-supplied string must name its verifier.
6. `we:scripts/lib/resource-gate.mjs:37` — Add a deterministic import-cycle check that rejects newly introduced module cycles.
7. `we:scripts/lib/resource-gate.mjs:230` — Add a deterministic parameterized unit test asserting that the lowering branch never exceeds the original floor or configured ceiling, including floor=ceiling=1 with default lowerMinimum=2; run it in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4814@ef773f3eb09abe8c1e78cf336182d4c76555f2c0

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
