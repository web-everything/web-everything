---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/lib/daemon-rebuild/__tests__/plan.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a table-driven test over decision kinds (set-aside, ordinary drop, pin-skip, unaudited-hold)… (from web-everything/web-everything#7368 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/plan.mjs:45` — Add a table-driven test over decision kinds (set-aside, ordinary drop, pin-skip, unaudited-hold) that asserts the strictness outcome for each. Document the widened scope in the PR template's behaviour-change line.
2. `we:scripts/lib/daemon-rebuild/plan.mjs:1010` — Add a planner test where a held-unaudited conflicting overlay stays in establishedLost (no setAside decision). Alternatively add a mutation-style check that each clause of the eligibility conjunction is exercised.
3. `we:scripts/lib/daemon-rebuild/plan.mjs:1013` — Add a test in we:main-sync-set-aside.test.mjs for the unaudited-tip conflict drop, and keep a doc-claim-to-test mapping for each 'never applies to X' sentence in we:testing.md.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7368@25ca0771d966f6098a2a38b9684ee6ae2f2f4830

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
