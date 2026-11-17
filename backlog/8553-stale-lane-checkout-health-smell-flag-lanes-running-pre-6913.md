---
bornAs: x9t7kkq
kind: story
size: 3
status: open
dateOpened: "2026-11-16"
scope: ["we:scripts/conveyor/health-smells/lane-stale-checkout.mjs", "we:scripts/conveyor/health-smells/__tests__/lane-stale-checkout.test.mjs", "we:scripts/conveyor/lane-checkout-probe.mjs", "we:scripts/conveyor/health-watch.mjs"]
tags: []
---

# Stale-lane-checkout health smell: flag lanes running pre-#6913 forge code or far behind main

Lanes lane-8/lane-10 ran pre-#6913 forge-exec-run code and corrupted shared Forge health state; clone-stale/clone-behind-main only cover daemon clones, not pool lanes.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/run.mjs vitest we:scripts/conveyor/health-smells/__tests__/lane-stale-checkout.test.mjs` (stale lane flagged, fresh lane not).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not reset or fix lanes, and does not touch daemon clones (clone-stale / clone-behind-main own those).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: n/a: read-only git/file reads, no untrusted text rendered.
2. **Truncated reads** — TODO: a missing or unreadable file is reported as unknown, not stale.
3. **Shared state files** — TODO: n/a: read-only.
4. **Fail closed** — TODO: unreadable lane means no breach (unknown), never a guessed one.
5. **Identity scoping** — TODO: one subject per pool/lane.
6. **State over time** — TODO: breach closes once the lane is refreshed.
7. **Who wrote it** — TODO: n/a: no writes.
