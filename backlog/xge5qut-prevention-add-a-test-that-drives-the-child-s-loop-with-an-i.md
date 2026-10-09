---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/await-verify-loop.mjs", "we:scripts/conveyor/__tests__/await-verify-loop.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test that drives the child's loop with an injected hook and asserts the hook runs each iter… (from web-everything/web-everything#4575 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#4575's review (reviewed head `23054c82fa847707963bff7eb792d9f3c372fd50`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/await-verify-loop.mjs:452` — Add a test that drives the child's loop with an injected hook and asserts the hook runs each iteration. Longer term, a standards rule that every new loop-child hook has a test referencing the loop entry.

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
