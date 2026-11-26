---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-audit-io.mjs", "we:scripts/lib/audit-settings.mjs", "we:scripts/operations/__tests__/codex-audit-io.test.mjs", "we:scripts/lib/__tests__/audit-settings.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add the adapter-level rejection test. A longer-term guard is a coverage rule requiring every thro… (from web-everything/web-everything#7542 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/codex-audit-io.mjs:98` — Add the adapter-level rejection test. A longer-term guard is a coverage rule requiring every `throw new Error` in a *-io.mjs adapter to be hit by at least one test.
2. `we:scripts/lib/audit-settings.mjs:373` — Add a test that sets the env var to a missing file. Mutation-test new fail-closed branches in settings resolvers.
3. `we:scripts/operations/codex-audit-io.mjs:97` — Add a lint or `check:standards` rule, or a reviewer-lens checklist item, requiring a named negative test for every new input-validation throw. Failing that, add a mutation-probe step in CI for new guard lines.
4. `we:scripts/lib/audit-settings.mjs:361` — Add a deterministic parameterized resolver test covering every supported integer from 0 through 3, asserting the returned value and absence of policy errors.
5. `we:scripts/operations/codex-audit-io.mjs:99` — Add a table-driven adapter rejection test to the automated test gate, with a mutation check that removing the scope guard makes that named test fail.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7542@c407edce8bfc3ebe9cbc79294db6b45aaae7b19a

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
