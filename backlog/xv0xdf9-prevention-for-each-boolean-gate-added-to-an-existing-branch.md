---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/conveyor/__tests__/fix-procedure.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — For each boolean gate added to an existing branch, require a test that flips only that operand. M… (from web-everything/web-everything#7567 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs:1265` — For each boolean gate added to an existing branch, require a test that flips only that operand. Mutation testing in CI over the diff's changed lines would find this class of gap automatically.
2. `we:scripts/operations/fix-run.mjs:649` — A lint rule that flags a JSDoc block whose @returns type disagrees with the function it attaches to.
3. `we:scripts/conveyor/fix-procedure.mjs:93` — Add to the round-trip test `expect(body.match(/--&gt;/g)).toHaveLength(1)` and `expect(body.indexOf('--&gt;')).toBe(body.length - 3)`. More generally, give every marker builder a shared test helper that asserts one comment terminator, at the end.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7567@0b5655bc8bec374aed19099c18d7e9e4ce7dba75

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
