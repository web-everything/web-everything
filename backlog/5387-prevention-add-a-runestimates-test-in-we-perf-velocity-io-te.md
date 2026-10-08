---
bornAs: xgfsy4h
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/perf-velocity-io.mjs", "we:scripts/lib/__tests__/model-settings.test.mjs", "we:scripts/operations/__tests__/perf-velocity-io.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a runEstimates test in we:perf-velocity-io.test.mjs that records the model passed to the fake… (from web-everything/web-everything#4444 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/perf-velocity-io.mjs:154` — Add a runEstimates test in we:perf-velocity-io.test.mjs that records the model passed to the fake spawn and written into the rows. More generally, require a wiring assertion at the call site whenever a setting is added to a consumer.
2. `we:scripts/lib/__tests__/model-settings.test.mjs:17` — Add a deterministic regression test with valid model IDs under both allowed and unknown keys in the same allowed group, asserting the exact filtered result.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4444@d484d26425cd8340d423bad95f45bf24719a2222

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
