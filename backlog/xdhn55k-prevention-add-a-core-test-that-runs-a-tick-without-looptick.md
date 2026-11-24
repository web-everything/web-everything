---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs", "we:scripts/conveyor/health-loop-ticks.mjs", "we:scripts/conveyor/__tests__/health-watch-core.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/conveyor/__tests__/health-loop-ticks.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a core test that runs a tick without loopTicks after an open episode and asserts the episode… (from web-everything/web-everything#7417 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch-core.mjs:937` — Add a core test that runs a tick without `loopTicks` after an open episode and asserts the episode and `state.loopTicks` are unchanged. Add a `health-watch` tick fixture test with a drain log and a builder log that asserts `state.loopCursors` and `probes.loopTicks`. Longer term, a standards rule could require each new smell probe to have an absent-probe test.
2. `we:scripts/conveyor/health-watch.mjs:1230` — Add a tick()-level test with a stub log dir that asserts the loopTicks probe and the loopCursors state. Fold it into the dlv:ZERO-SUCCESS-HARDEN card.
3. `we:scripts/conveyor/health-smells/__tests__/zero-success-alarm.test.mjs:1` — Add a notify-list test asserting zero-success-alarm is absent until an operator ruling. Add a loop-set assertion.
4. `we:scripts/conveyor/health-loop-ticks.mjs:112` — Run error strings through the existing secret-scrub helper in normalizeLoopTick. Add a test with a token-shaped string.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7417@b5eb38ca542713e5a36471f13364cc333aac3987

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
