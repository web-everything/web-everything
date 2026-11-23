---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/delivery-tier.mjs", "we:scripts/lib/__tests__/delivery-tier.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a highExamples entry for we:scripts/lib/__tests__/delivery-tier.test.mjs, or a rule that test… (from web-everything/web-everything#7397 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/delivery-tier.mjs:28` — Add a `highExamples` entry for we:scripts/lib/__tests__/delivery-tier.test.mjs, or a rule that tests for any HIGH module inherit HIGH. Better still, a parity test that every must-stay source glob has a matching tests glob.
2. `we:scripts/lib/delivery-tier.mjs:57` — Add a test that every agent-instruction filename (we:CLAUDE.md, we:AGENTS.md, skills and commands directories) is HIGH. Match globs case-insensitively for HIGH rules only. Add a check:standards rule that narrows LOW to explicit docs directories.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7397@1c90ec5fcffc896516a04092760c2fc6d11e3782

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
