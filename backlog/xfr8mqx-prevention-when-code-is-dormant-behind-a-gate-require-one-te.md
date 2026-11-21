---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs", "we:scripts/operations/agy-fix-provider.mjs", "we:scripts/lib/agy-fix-admission.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/settings/agy-build.json", "we:scripts/operations/__tests__/agy-fix-provider.test.mjs", "we:scripts/lib/__tests__/agy-fix-admission.test.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — When code is dormant behind a gate, require one test with the gate stubbed open. It should assert… (from web-everything/web-everything#7290 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/fix-executor-routing.test.mjs:513` — When code is dormant behind a gate, require one test with the gate stubbed open. It should assert the admitted decision and the forwarded request fields, as the fix-run test already does for the provider.
2. `we:scripts/operations/agy-fix-provider.mjs:13` — Add a test that asserts the `runTask` payload kind equals `admission.kind`. Alternatively, pass `admission.kind` and `admission.size` through.
3. `we:scripts/lib/agy-fix-admission.mjs:78` — Add a table test for absent-item-scope and absent-`--num` cases in fix-run and admission. Fix this before PR-b lifts the freeze.
4. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:1311` — Make antigravity availability require an explicit `launcherAvailable` function, and add a routing test for the omitted-argument case.
5. `we:scripts/settings/agy-build.json:1` — Add a lint that every `scripts/settings/*.json` key has a reader in scripts. Also drop `changeVia: env` for settings with no reader.
6. `we:scripts/lib/agy-fix-admission.mjs:17` — Require each capability retained during a split to map to a currently supported production path; defer policy used only by future capabilities and their tests.
7. `(no file cited)` — Add a named deterministic diff-size check that defines excluded test files and asserts non-test additions are at most 300 against the review base.
8. `(no file cited)` — Add a named CI check that counts non-test added lines against the designated base and asserts the count is at most 300.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7290@79a26f7ca5c9fdc9a9e75594603d2774962da59a

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
