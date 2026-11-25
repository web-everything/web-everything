---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-fast-pass-cli.mjs", "we:backlog/x7fp747-review-admission-mutation-and-ownership.md", "we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/review-stack-base.mjs", "we:scripts/lib/__tests__/review-fast-pass-cli.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/conveyor/__tests__/review-stack-base.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a table-driven cascade-policy test helper requiring one invalid-value and one default case pe… (from web-everything/web-everything#7450 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:scripts/lib/review-fast-pass-cli.mjs:112` — Add a table-driven cascade-policy test helper requiring one invalid-value and one default case per `valid` predicate, or extend the x7fp747 mutation gate to cover `cascadePolicy` validators.
2. `we:scripts/lib/review-fast-pass-cli.mjs:88` — Add a table-driven test over every `checkMainStaleness` result shape (fresh, synced, warn with behind/ahead/dirty, offline) asserting the fast-pass wrapper's admit/refuse decision. Fold it into the filed mutation gate (backlog x7fp747) so removing the `action !== 'warn'` clause must fail a named test.
3. `we:backlog/x7fp747-review-admission-mutation-and-ownership.md:16` — Require an acceptance-to-test mapping through the same deterministic backlog gate, including named tests that deliberately supply surviving mutations and incomplete mutation runs.
4. `we:scripts/operations/review-pr-io.mjs:418` — Add the independent local-mismatch fixture and include removal of this second assertion in a deterministic admission mutation gate.
5. `we:scripts/conveyor/review-stack-base.mjs:505` — Extend the admission mutation gate with a same-author moved-bottom fixture that requires refusal and fails when the untrusted-ancestor guard is removed.
6. `we:scripts/operations/review-pr-io.mjs:418` — Add the isolated local-revision test to the admission mutation gate and require removal of this assertion to fail it.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5360, finding 8 → #5590.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7450@ca3eab043c2e7a5c627316a13f4306684992ff53

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
