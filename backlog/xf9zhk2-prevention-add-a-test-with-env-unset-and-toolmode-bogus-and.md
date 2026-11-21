---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/drain-async-shadow.test.mjs", "we:scripts/lib/drain-async-shadow.mjs", "we:scripts/settings/drain-async-shadow.json", "we:scripts/lib/__tests__/drain-async-shadow.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a test with env unset and toolMode:'bogus' (and one where readSettings throws) that asserts n… (from web-everything/web-everything#7308 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/drain-async-shadow.test.mjs:280` — Add a test with env unset and toolMode:'bogus' (and one where readSettings throws) that asserts nothing is written. A mutation-check lens could also require each branch of a precedence chain to be isolated in its own test.
2. `we:scripts/lib/drain-async-shadow.mjs:43` — Add two cases: env shadow with toolMode off, and mode off with env shadow. A table-driven precedence test over (option, env, tool) would cover the whole chain.
3. `we:scripts/__tests__/drain-async-shadow.test.mjs:289` — Add a test for each precedence layer in isolation, with the higher layers unset. A table-driven test over (option, env, toolMode) combinations would catch this class of gap.
4. `we:scripts/__tests__/drain-async-shadow.test.mjs:276` — Add a table-driven mode-resolution test gate that exercises each configuration source with higher-precedence sources absent, including invalid values.
5. `we:scripts/settings/drain-async-shadow.json:2` — Add deterministic byte-bound and clock-controlled retention tests to the test gate and reference their names alongside these guarantees.
6. `we:scripts/lib/drain-async-shadow.mjs:43` — Add a table-driven mode-resolution regression test covering absent, empty, valid, and invalid environment values against the shadow tool default.
7. `we:scripts/__tests__/drain-async-shadow.test.mjs:276` — Add deterministic precedence-table tests that exercise each configuration source with higher-priority sources absent, including invalid tool values.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7308@15447ba064e80e64a91be75c6de8b2a546391da4

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
