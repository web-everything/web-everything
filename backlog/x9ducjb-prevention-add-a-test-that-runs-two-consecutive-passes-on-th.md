---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-loop/round-end-gates.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/lib/review-loop/intake.mjs", "we:scripts/lib/review-loop/__tests__/round-end-gates.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs", "we:scripts/lib/review-loop/__tests__/intake.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a test that runs two consecutive passes on the same head and asserts exactly one event per (p… (from web-everything/web-everything#7313 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-loop/round-end-gates.mjs:43` — Add a test that runs two consecutive passes on the same head and asserts exactly one event per (pr, head, kind). Dedupe on that key in the events layer or in the effects child.
2. `we:scripts/conveyor/reconcile-pass.mjs:1926` — Wrap the settings load so a failure degrades to enforce:'off' plus a loud note (or to 'unmeasurable' under 'on'). Add a reconcile-pass test with a throwing `loadIntake` asserting the pass still plans.
3. `we:scripts/lib/review-loop/intake.mjs:7` — Add a lint or test that every shipped setting key is read by a consumer, or drop the key until A4b.
4. `we:scripts/conveyor/reconcile-pass.mjs:1927` — Add a reconcile-pass test where `loadIntake` throws under shadow, and wrap the load so shadow degrades to enforce 'off' plus a warning. A broader guard would be a check:standards rule requiring that any new reconcile-pass setting load either sits inside `step()` or has a throwing-loader test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7313@ae146c244b479d95b38b09f759123cb308fb330b

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
