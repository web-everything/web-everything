---
kind: story
size: 5
priority: high
parent: "x6woyws"
status: open
blockedBy: ["xkuflno"]
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Resource service slice 2: cut load-flake re-arm and daemon rebuild smoke over to admit()

After slice 1's shadow log shows the new verdict is right, the load-flake reverify pass (we:scripts/conveyor/load-flake-reverify.mjs planLoadFlakeReverify 'host-load' deferral, today load average per core vs maxLoadPerCore) first gains its shadow call (its file was held by PR #4700 during slice 1), then decides through admit({kind:'load-flake-rearm'}); the rebuild smoke's hostLooksBusy and load-scaled budgets (we:scripts/lib/daemon-live-smoke.mjs) and the load-shaped env hold (we:scripts/lib/daemon-rebuild/smoke.mjs, held by PR #4712 during slice 1) decide through admit({kind:'rebuild-smoke'}). Register the sampler supervisor as a managed daemon in we:skills-src/conveyor/daemon-manifest.mjs (held by PR #4691 during slice 1). Old load-average branches stay only as the logged comparison until slice 4. Done when: tests pin the cut-over; LIVE proof — at load average above 9 with CPU idle above the policy floor, the reverify pass and a rebuild smoke proceed, with the log line naming the admit verdict.

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
