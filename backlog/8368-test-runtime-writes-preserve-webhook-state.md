---
bornAs: xu5b7h1
kind: story
size: 1
parent: "5452"
status: open
scope: ["we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Test runtime appends preserve populated webhook clocks and PR projections

Prevention filed for PR #6889 review at head 7394c94691d07b2a2873fe0a9af946404f197a29, codex-correctness/coverage; also raised by the simplicity advisory at we:scripts/conveyor/pr-events-worker/core.mjs:16. The existing duplicate-only clock assertion would miss successful runtime writes changing webhook health or PR projections.

## Acceptance

- [A1] **Executable** — add 'runtime appends preserve populated webhook clocks and PR projections' in we:scripts/conveyor/pr-events-worker/__tests__/core.test.mjs. Populate webhook state with GitHub facts and snapshot lastDeliveryAt, lastEventAt, repoEvents and existing PR projections before runtime writes.
- [A2] Append each runtime type successfully at a later injected time, then duplicate it. Assert all captured health/projection values remain unchanged while runtime rows appear once under increasing seq. Include a different repo and PR so accidental projection creation is detected.
- [A3] Demonstrate red when ordinary successful runtime append updates webhook clocks, repoEvents or PR projections; do not rely only on the duplicate path or empty initial state.

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
