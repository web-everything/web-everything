---
bornAs: xlvsauc
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-state.mjs", "we:scripts/lib/pr-state/holds/same-head-cap.mjs", "we:scripts/lib/pr-state/holds/index.mjs", "we:scripts/lib/__tests__/pr-state.test.mjs", "we:scripts/lib/pr-state/holds/__tests__/same-head-cap.test.mjs", "we:scripts/lib/pr-state/holds/__tests__/index.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a table-test assertion for every restricted row that next and needsYou do not contain the REA… (from web-everything/web-everything#4326 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-state.mjs:128` — Add a table-test assertion for every restricted row that `next` and `needsYou` do not contain the READY text. Better, make `lifecycleOf` return an overriding headline and next alongside the state, so `finish` never mixes the two.
2. `we:scripts/lib/pr-state/holds/same-head-cap.mjs:8` — Validate numeric settings with a shared clamp/validator and add a table-test row for out-of-range values.
3. `we:scripts/lib/pr-state/holds/index.mjs:23` — Pass extra rules a structuredClone or deep-frozen copy of `ctx`. Also add a test where an extra rule mutates `ctx.view.clears` and the derive result is asserted unchanged. A lint rule that flags extension points declaring an effect with no frozen-input test would catch the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4326@e88b5a50598462f24aab74bcc5e8a4833b773577

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
