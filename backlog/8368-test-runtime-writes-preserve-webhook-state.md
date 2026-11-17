---
bornAs: xu5b7h1
kind: story
size: 1
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs", "we:docs/agent/reviewer-expectations.md"]
dateOpened: "2026-11-15"
tags: []
---

# Test runtime appends preserve populated webhook clocks and PR projections

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29, codex-correctness/coverage; also raised by the simplicity advisory at we:scripts/conveyor/pr-events-worker/core.mjs:16. The existing duplicate-only clock assertion would miss successful runtime writes changing webhook health or PR projections.

Latest advisory linkage: PR #6889, 2026-11-16T05:37:58Z, head ae079849826a461c809a93df310d133f759eb31c. A1–A3 carry correctness/test-coverage and security/coverage's successful-write isolation requests, also raised as simplicity and codex-correctness card suggestions. A4 carries both lenses' prevention obligation to require populated-state snapshots around successful writes. Filing this plan does not add the missing runtime test or checklist rule.

## Acceptance

- [A1] **Executable** — add 'runtime appends preserve populated webhook clocks and PR projections' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs. Populate webhook state with GitHub facts and snapshot lastDeliveryAt, lastEventAt, repoEvents and existing PR projections before runtime writes.
- [A2] Append each runtime type successfully at a later injected time, then duplicate it. Assert all captured health/projection values remain unchanged while runtime rows appear once under increasing seq. Include a different repo and PR so accidental projection creation is detected.
- [A3] Demonstrate red when ordinary successful runtime append updates webhook clocks, repoEvents or PR projections; do not rely only on the duplicate path or empty initial state.
- [A4] Add a review-lens checklist item to we:docs/agent/reviewer-expectations.md: every 'does not touch X' promise needs a named test that snapshots populated X before and after a successful write. A duplicate-only or empty-state assertion cannot satisfy it. Include this runtime isolation regression as the concrete example.

## Test plan

- A1–A3 — **Preservation (GREEN today)**: planned 'runtime appends preserve populated webhook clocks and PR projections' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs. Snapshot before the first successful write, check after each runtime type and duplicate, and assert each first write actually increments seq. Planned mutation proof: remove each health/projection guard independently.
- A4 — **Capability (Red today)**: review the new checklist text against a successful-write example and a duplicate-only counterexample; require the latter to be identified as insufficient. The specific checklist requirement is the planned addition.

## Proof plan

Record the named test's red/green evidence for each health/projection guard and the foldObservation early return. Cite the checklist line and its two examples. This card captures the general prevention obligation as well as the runtime-specific test; filing it does not implement either.

## Non-goals

- [N1] No runtime consumer, projection schema or webhook-health policy changes.

## Edge cases this change must handle

1. **Untrusted text** — n/a: valid fixture events only.
2. **Truncated reads** — n/a: fixtures fit one read page.
3. **Shared state files** — snapshot populated state before each write class.
4. **Fail closed** — n/a: schema rejection is already covered separately.
5. **Identity scoping** — runtime writes for another repo/PR must not create webhook projections.
6. **State over time** — later successful writes and duplicates preserve both clocks.
7. **Who wrote it** — cover decider and executor runtime types without changing token policy.
