---
bornAs: x1iq3k2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a deterministic test in we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs named 'u… (from web-everything/web-everything#5119 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:225` — Add a deterministic test in we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs named 'uses the shared required-check reader by default for ruleset-only failures': mock the shared dependency, omit both reader overrides, and assert that merge-gate produces a rebase-onto-main dispatch. Reverting the default reader must make this test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5119@017ec940137b1318085b9e6f7b4d6692cdd2cfe9

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
