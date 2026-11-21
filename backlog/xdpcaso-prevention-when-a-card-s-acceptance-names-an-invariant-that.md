---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — When a card's Acceptance names an invariant that must hold across the change, require a test-plan… (from web-everything/web-everything#7247 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4448` — When a card's Acceptance names an invariant that must hold across the change, require a test-plan row naming the test and asserting it. A review lens or a card-lint rule that maps each Acceptance clause to a named test would catch this.
2. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs:4443` — Add a lint or check:standards rule that each Acceptance bullet in a card or PR maps to a named test, or require a 'guarantee -> test' table in the PR template.
3. `we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs` — Add a named test 'expired runtime list keeps builds capped at zero' with an expired only-mode list, explicit zero build cap, and otherwise eligible build candidates; assert zero build dispatches while eligible prepares still launch. Include it in the automated test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7247@e04c73013f93b3ce950000ab31c5f4e0e3d01947

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
