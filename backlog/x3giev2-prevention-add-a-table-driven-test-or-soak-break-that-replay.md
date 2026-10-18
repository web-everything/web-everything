---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/__tests__/stand-down-head-reconcile.test.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/stand-down.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a table-driven test or soak break that replays an unbound hold for each STAND_DOWN_REASONS en… (from web-everything/web-everything#5384 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/stand-down.mjs:236` — Add a table-driven test or soak break that replays an unbound hold for each STAND_DOWN_REASONS entry with later head-commit evidence and states which reasons may lapse. Restrict the lapse to the reasons that are allowed to release.
2. `we:scripts/conveyor/__tests__/stand-down-head-reconcile.test.mjs:59` — Add an integration replay test through `enrichPrsWithCompleteComments` into `planReconcile`, and one through `runReconcilePass` with the setting injected.
3. `we:scripts/conveyor/stand-down.mjs:211` — Add a lens or lint rule that flags `committedDate`/`authoredDate` used in a trust or lapse decision. Prefer push-time evidence (timeline events), or record the head in every unbound hold at post time so no clock comparison is needed.
4. `we:scripts/conveyor/stand-down.mjs:190` — For settings that guard a hold or refusal, add a check:standards rule or a shared helper option so an invalid value fails closed (here, hold) and is always logged. Add a table test per such setting that sends invalid env and tool values.
5. `we:scripts/conveyor/reconcile-core.mjs:2369` — Add a reason-by-reason lapse matrix test (one row per STAND_DOWN_REASONS entry, plus human-posted) so widening the lapse needs an explicit decision per reason.
6. `we:scripts/conveyor/reconcile-core.mjs:1994` — Have `planReconcile` default to `resolveStandDownHoldsAcrossHeads()`, as the neighbouring settings do, or add a test that lists every production planReconcile caller and checks it passes the setting.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5384@d7ca5a1c620414946cefc78f4db07f5eabf9c604

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
