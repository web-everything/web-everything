---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a CLI-level regression test that forces the pool read to fail and asserts exit 0 with the deg… (from web-everything/web-everything#4647 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/readiness/dispatch-plan.mjs:1068` — Add a CLI-level regression test that forces the pool read to fail and asserts exit 0 with the degraded marker. A review lens 'every fail-soft guarantee needs a forced-failure test at the entrypoint' would catch the class.
2. `we:scripts/readiness/dispatch-plan.mjs:786` — A lint rule for orphaned or duplicate JSDoc blocks in `check:standards`.
3. `we:scripts/readiness/dispatch-plan.mjs:929` — Add deterministic CLI regression tests with a failing lane-pool stub, and run them in the existing test gate.
4. `we:scripts/conveyor/__tests__/tick-core.test.mjs:2382` — Add deterministic CLI integration tests with a failing pool stub and invocation counter to the regular test gate; verify that removing the soft-read option or bypassing reuse makes those named tests fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4647@f80c881a4d38d23b3e50d56974aa35ef1eeadbe9

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
