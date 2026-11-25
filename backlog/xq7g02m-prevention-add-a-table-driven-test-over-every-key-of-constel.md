---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a table-driven test over every key of CONSTELLATION_REPOS and PENDING_REPOS other than WE, as… (from web-everything/web-everything#7461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:455` — Add a table-driven test over every key of CONSTELLATION_REPOS and PENDING_REPOS other than WE, asserting the fallback never names a file the checkout lacks.
2. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:157` — In the skip test, assert `decision.standards.reason` contains 'standards step SKIPPED'.
3. `we:scripts/lib/verify-lane-gate.mjs:61` — Review lens: when a branch weakens a 'mandatory' or 'bypasses' statement, search the file for that statement and update it. No cheap deterministic gate exists for this.
4. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:152` — Add expect(none.decision.standards.reason).toContain('standards step SKIPPED') to the skip case. As a review lens, require an assertion for each field the acceptance or pre-mortem names.
5. `we:scripts/lib/verify-lane-gate.mjs:522` — File the reinforce-later card the PR mentions: declare each repo's standards command in the repo profile, and fail closed when a declared command is missing or we:package.json cannot be read.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7461@4f1c2c30a0fd6c0c15959592eeebddba0ee935d3

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
