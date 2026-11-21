---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-prestage.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/__tests__/drain-prestage.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a unit test that fails when a gate result with unknown: true maps to 'red' in prestageCi. Lon… (from web-everything/web-everything#7160 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/drain-prestage.mjs:36` — Add a unit test that fails when a gate result with `unknown: true` maps to 'red' in prestageCi. Longer term, have the gate return a tri-state so callers cannot collapse unknown into red.
2. `we:scripts/merge-ai-prs.mjs:5271` — Add a wiring test for each call site (drain revalidation, pre-stage `readPr`, land-human-only reader) that serves a `total_count` larger than the delivered rows and asserts refusal with no write or enqueue. A check:standards rule could also ban literal `rowsComplete: true` in non-test scripts, so provenance can only come from `readReviewChecks`.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5039, finding 4 → #4706.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7160@020d1a216f645b686f07548f85a57b511fa434b7

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
