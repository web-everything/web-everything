---
bornAs: x30jkq3
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs", "we:scripts/pr-land.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/operations/__tests__/open-pr-io.test.mjs", "we:scripts/__tests__/pr-land.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a caller-level test that an org-first PATH is returned unchanged. Better, have the helper ret… (from web-everything/web-everything#4420 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/open-pr-io.mjs:56` — Add a caller-level test that an org-first PATH is returned unchanged. Better, have the helper return the PATH string unchanged instead of null for the already-first case, so the two outcomes cannot be confused.
2. `we:scripts/conveyor/__tests__/reconcile-core.test.mjs:3613` — Add table-driven cases (empty rollup, pending rollup, green rollup) for each new branch condition in `planReconcile`, written as part of the same change.
3. `we:scripts/pr-land.mjs:142` — Extract the swap into a pure function, e.g. `applyOrgShimToPath(env)` in we:gh-app-shim.mjs, and unit-test the "legacy absent means untouched" case.
4. `we:scripts/conveyor/reconcile-core.mjs:1891` — Add a table-driven test over every `withPhase.check` value for stacked PRs, plus one asserting the downstream review gate still holds when checks are pending.
5. `we:scripts/operations/open-pr-io.mjs:55` — Add a deterministic resolver regression test with ORG already first, legacy absent from PATH but present on disk, and assert that ORG remains first.
6. `we:scripts/pr-land.mjs:145` — Add a deterministic direct-pr-land PATH precedence test with a custom gh before the legacy directory and assert that the custom executable remains selected.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4420@dc084068a208f027aba74f47aba9165ec66807ce

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
