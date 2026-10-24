---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/auto-rebase.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Prevention — Add a fixture-parity test where main also changes a docs or JSON file and a deleted file, and ass… (from web-everything/web-everything#5848 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:172` — Add a fixture-parity test where main also changes a docs or JSON file and a deleted file, and assert the intended outcome. Or restrict the 'no related tests' check to the conflict paths and the fixer's edits, and treat other main-originated files as already tested upstream.
2. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:172` — For every fail-closed guard in the worker, require a paired mutation test whose fake agent breaks the invariant. Enforce it with a review-lens checklist, or a standards rule that each `throw new Error(...)` guard in we:scripts/lib/daemon-rebuild/auto-rebase.mjs is named in a test.
3. `we:scripts/lib/daemon-rebuild/prepare.mjs:74` — Drive the gate from a table of state predicates with one test row per predicate, so adding a clause forces adding a row.
4. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:47` — Add a standards-check rule that every new exported entry point taking a ref or path has a hostile-input test. Alternatively, a shared table-driven hostile-ref test for functions that call isSafeBranchName.
5. `we:docs/agent/testing.md:15` — Add a deterministic regression test exercising the production subprocess runner with a controlled waiting child and asserting that a heartbeat occurs before the child exits.
6. `we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs:125` — Add a deterministic regression test that exercises the production child-execution adapter and asserts that a heartbeat occurs before the child completes; replacing asynchronous execution with synchronous execution must fail that test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5848@674622a82b9f5f3255b65510ab290a9d30c50f1f

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
