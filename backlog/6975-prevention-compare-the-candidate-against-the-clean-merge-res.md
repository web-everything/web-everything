---
bornAs: xbactk4
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/lib/daemon-rebuild/prepare.mjs", "we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs", "we:docs/agent/testing.md", "we:scripts/lib/daemon-rebuild/__tests__/auto-rebase.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/prepare.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Compare the candidate against the clean merge result (or against git merge-tree), and only flag t… (from web-everything/web-everything#5848 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:165` — Compare the candidate against the clean merge result (or against `git merge-tree`), and only flag tests that are absent from that clean result. Add a fixture where main deletes or renames a test.
2. `we:scripts/lib/daemon-rebuild/prepare.mjs:72` — For each conjunct of the cleanup precondition, add a table-driven scenario that flips only that conjunct.
3. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:112` — Add a test that injects `lstatSync` and `openSync` failures and an undefined `O_NOFOLLOW`, asserting that evidence omits the file and the job proceeds.
4. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs:128` — Route `constants` through the injected `io` (for example `io.constants ?? fs.constants`) and add a case where `io.constants.O_NOFOLLOW` is undefined and asserts that `openSync` is never called. More generally, a check:standards rule could flag prose claims of platform-conditional behaviour that have no matching named test.
5. `we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs` — Add single-variable fixtures and a targeted mutation gate that removes addedAt from comparison and requires those named tests to fail.
6. `we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs` — Add a default-executor liveness test and a targeted mutation gate that substitutes synchronous execution and requires that test to fail.
7. `we:docs/agent/testing.md` — Add deterministic fault-injection cases for each documented boundary and targeted mutations of the skip and exception-isolation guards.
8. `we:scripts/lib/daemon-rebuild/auto-rebase.mjs` — Add conditional removal under the overlay-list mutex and a deterministic regression test that withdraws the replacement immediately before the locked removal.
9. `we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs` — Gate changes with a subprocess integration test using a harmless delayed child and an observable heartbeat before child completion.
10. `we:docs/agent/testing.md` — Add parameterized fault-injection tests for the documented capture boundaries, asserting both skipped operations and preservation of unrelated evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5848@5832a4799b4f26d02b9516da040541468bd11d47

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
