---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/delivery-priority-shadow.mjs", "we:scripts/lib/__tests__/fixtures/delivery-priority.replay.json", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/delivery-priority-shadow.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a runner-level test for any new injectable hook in runReconcileFixDispatch: result with the h… (from web-everything/web-everything#4540 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1459` — Add a runner-level test for any new injectable hook in `runReconcileFixDispatch`: result with the hook null vs stubbed must have identical `dispatched` and `refusals`. Default new observer hooks to off in tests via a shared test helper.
2. `we:scripts/conveyor/delivery-priority-shadow.mjs:36` — Restrict code-free to `backlog/` and `docs/` prefixes (or a declared setting), and add a shadow-test case with a `skills-src/*.md` path expecting `changesCode:true`. A fixture per path class is the cheapest guard.
3. `we:scripts/conveyor/delivery-priority-shadow.mjs:33` — Require `repo` to be a non-empty string in readMainRedOwner and drop the null-matches-all branch. Add a fixture-driven test for a repo-less record. A review lens or lint check for `== null ||` wildcard identity matches would catch the class.
4. `we:scripts/conveyor/delivery-priority-shadow.mjs:18` — Use `Object.hasOwn(PRIORITY_OVERRIDE_LABELS, l)` or a Map. A lint rule against bracket lookup of untrusted keys on object literals is the deterministic gate.
5. `we:scripts/conveyor/delivery-priority-shadow.mjs:49` — Require a valid repository in the reader and exact equality in the adapter; add a deterministic regression test asserting that missing-repository records cannot grant P0 across repositories.
6. `we:scripts/lib/__tests__/fixtures/delivery-priority.replay.json:141` — Extend the named replay with same-class items having different nonzero unblock counts, assert exact scores and order, and use a nondefault weight so hardcoding 60 also fails.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4540@15321728ec5b77066eac1e1d4e6290211873df88

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
