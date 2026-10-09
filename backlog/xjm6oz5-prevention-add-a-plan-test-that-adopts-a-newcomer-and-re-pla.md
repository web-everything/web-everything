---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/__tests__/plan.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/smoke.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a plan test that adopts a newcomer and re-plans with headSha set to the adopted finalSha, ass… (from web-everything/web-everything#4712 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:126` — Add a plan test that adopts a newcomer and re-plans with headSha set to the adopted finalSha, asserting upToDate. A cheap fix is to keep the previously applied relative order for established overlays, or to put newcomers last in list order.
2. `we:scripts/lib/daemon-rebuild/smoke.mjs:284` — Add a deterministic unit test supplying a dispatch result with a distinctive duration and asserting its exact timing entry in the emitted log; require it in the unit-test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4712@df7167c444c0a14e7116b0713f7c81d495b00f75

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
