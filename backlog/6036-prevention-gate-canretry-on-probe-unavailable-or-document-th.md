---
bornAs: xwyt3vb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Gate canRetry on probe.unavailable (or document the intentional retry-regardless), and have the t… (from web-everything/web-everything#5045 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/daemon-live-smoke.mjs:1030` — Gate `canRetry` on `probe.unavailable` (or document the intentional retry-regardless), and have the test assert the attempt count for the probe-ok case against the written contract.
2. `we:scripts/lib/daemon-live-smoke.mjs:1236` — Count a probe timeout as unavailable only when the elapsed time is at least the configured probe budget, and add a test that runs the probe through `budgetedRunChild` with a short deadline.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 1 → #5985.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5045@922a19a18cd6f25f6838b98b79127277247bd5bc

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
