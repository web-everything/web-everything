---
bornAs: x6nol3h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/resource-sampler.test.mjs", "we:scripts/lib/resource-sampler.mjs", "we:scripts/lib/resource-policy.mjs", "we:scripts/conveyor/resource-sampler-daemon.mjs", "we:scripts/lib/resource-admission.mjs", "we:scripts/lib/__tests__/resource-policy.test.mjs", "we:scripts/conveyor/__tests__/resource-sampler-daemon.test.mjs", "we:scripts/lib/__tests__/resource-admission.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test that points the sampler at a temp checkout containing .lanes/repo/lane-N directories a… (from web-everything/web-everything#4722 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/resource-sampler.test.mjs:98` — Add a test that points the sampler at a temp checkout containing `.lanes/<repo>/lane-N` directories and asserts the sampled `laneCount` and `heavySlots`. Longer term, a review-lens rule: a test named for a guarantee must route through the guarded argument.
2. `we:scripts/lib/resource-sampler.mjs:106` — Pass the configured `intervalMs` into `createSampler` and clamp the freshness window to it, with a test that a 10-minute gap still yields a 30 s `freshUntil`.
3. `we:scripts/lib/resource-policy.mjs:86` — Decide the policy for partially-null critical inputs (CPU idle) before slice 2 and pin it in a `resource-admission` test. Slice 2's cut-over tests should assert that a null CPU idle holds heavy kinds.
4. `we:scripts/lib/resource-policy.mjs:78` — In decideAdmission, treat a heavy kind with cpuIdlePct === null as unknown (hold). Add a test that a snapshot with all-null probes holds build and admits light. Fix this before the slice 3 (5715) cut-over; add it to that card's acceptance.
5. `we:scripts/conveyor/resource-sampler-daemon.mjs:58` — Require confirmed process exit before marking retirement complete and enqueueing a replacement; add deterministic tests for unknown probe results, failed signals, and delayed exit that assert no replacement is launched.
6. `we:scripts/lib/resource-admission.mjs:36` — Retain complete newest rows within a byte budget, define handling for an individually oversized row, and gate this with file-size assertions using uneven rows and an initially oversized file.
7. `we:scripts/lib/__tests__/resource-sampler.test.mjs:95` — Make the named test sample with default readers against distinct checkout and snapshot locations, asserting the observed lock root and lane directory; removing either checkoutRoot forwarding expression must fail it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4722@ea117e881164c3b6366b0bb78a3660c9a00503b1

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
