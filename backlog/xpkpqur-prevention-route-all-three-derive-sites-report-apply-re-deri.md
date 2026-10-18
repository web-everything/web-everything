---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Route all three derive sites (report, apply, re-derive) through one helper that takes readFacts,… (from web-everything/web-everything#5550 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/conveyor/pr-label-mirror.mjs:206` — Route all three derive sites (report, apply, re-derive) through one helper that takes readFacts, and add a parity test that runs report and apply on a non-default repo.
2. `we:scripts/operations/review-pr-io.mjs:1469` — Add a raceHarness case whose `during` hook re-triggers an operator ruling on every append and asserts the 'did not settle' error plus the resulting park or pending behaviour.
3. `we:scripts/operations/review-pr-io.mjs` — Extend the existing race test to assert that the sink's returned pending and blocked lists match the refreshed authoritative state.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5473, finding 4 → #5473, finding 6 → #5473, finding 7 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5550@92262f8cf087d8847dd38be69d5189c7d3ff796e

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
