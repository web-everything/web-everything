---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — File a card to add a repo-profile standards-command field, with a table-driven test over every CO… (from web-everything/web-everything#7461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:454` — File a card to add a repo-profile standards-command field, with a table-driven test over every CONSTELLATION_REPOS and PENDING_REPOS entry asserting the resolved gate names only paths or scripts that repo has.
2. `we:scripts/lib/verify-lane-gate.mjs:61` — Review lens: when a change makes a 'mandatory' or 'always' behaviour conditional, search the module header for that wording. No cheap deterministic gate fits free prose.
3. `we:scripts/lib/verify-lane-gate.mjs:994` — Add a describeGate test case for full mode with standards.run=false that asserts the headline does not claim standards ran.
4. `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:456` — Add `https://gitlab.com/plateauapp/plateau-app.git` to the 'unrecognized or WE origin keeps mandatory direct standards' table; more generally, mutation-check each new guard clause.
5. `we:scripts/lib/verify-lane-gate.mjs:524` — Block, or keep the failing command, when scripts is null, and add a named test for a sibling with scripts undefined. A review lens for tri-state inputs (present, absent, unknown) covers the class.
6. `we:scripts/lib/verify-lane-gate.mjs:455` — Add a table-driven test over every registered non-WE repo, including PENDING_REPOS, asserting the fallback never names an absent WE script.
7. `we:scripts/lib/verify-lane-gate.mjs:61` — A review lens: when a diff relaxes a 'mandatory' or 'always' behaviour, search the file for prose restating it and update it. This is not reliably script-decidable.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7461@eee1ac6429d738a0f2060278f7c43cc524e82dbc

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
