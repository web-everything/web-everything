---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/pr-status.test.mjs", "we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Add a test in we:scripts/operations/run.mjs coverage that asserts every op in the read-only regis… (from web-everything/web-everything#5867 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/run.mjs:752` — Add a test in we:scripts/operations/run.mjs coverage that asserts every op in the read-only registry maps to a memory store and zero-writes in the CLI path, or derive both lists from one shared constant.
2. `we:scripts/operations/__tests__/pr-status.test.mjs:520` — When a renderer states a width cap, add a table-driven test that feeds each column a value longer than its width and asserts every output line has the expected length. A lint or review lens on 'fixture values must exceed the cap' would catch the class.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5867@96d026070626e67444ccbdc8678087b708ca1a49

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
