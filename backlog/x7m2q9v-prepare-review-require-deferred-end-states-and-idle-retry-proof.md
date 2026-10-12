---
kind: story
size: 1
status: open
scope: ["we:skills-src/conveyor/prepare-item-agent-brief.md", "we:skills-src/conveyor/prepare-item-worker-brief.md", "we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prepare review: require deferred end states and idle retry proof

Prevention filed from PR #5026's 2026-10-12 changes-requested findings on #5749. A refused lock can leave an unpublished local merge, and a retry gated on newly landed work can strand previously deferred work forever. A source-text guard assertion proves neither recovery contract.

## Acceptance

- [A1] Prepare author/review instructions require every `ran:false` deferral to state local and remote end states (merged or unmerged, published or unpublished) and name a behavioural test asserting them.
- [A2] Every promise of retry on the next pass must name a durable trigger and a behavioural test whose next pass has no new work; an in-memory reporting bucket alone is not a trigger. Include process restart and preserved eligibility/evidence checks.
- [A3] Add contract coverage in `we:skills-src/conveyor/__tests__/prepare-brief-contract.test.mjs` for both requirements; use #5749's unpublished fallback merge and no-new-land numbering as review examples.

## Non-goals

- [N1] Runtime lock changes and fault/explicit-option tests belong to #5749; this item updates the reusable preparation instructions.

## Edge cases

- Distinguish work merged only locally from work already published remotely.
- Retry after a restart without relying on new unrelated work; incomplete evidence must continue to defer.
- A source-text assertion that push follows a guard does not replace an end-state test.
