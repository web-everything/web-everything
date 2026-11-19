---
bornAs: xuay23a
kind: task
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/await-verify-loop.mjs"]
dateOpened: "2026-11-11"
tags: []
---

# Hand off retained CI failure inventory before retiring an abandoned delivered wait, and cover the escalate case

Follow-up to lane/fix-admission-delivered-previous-ci (audit WEAKENED, ruled R896+R903). Retiring a dead or idle delivered previous-ci wait in we:scripts/conveyor/await-verify-pass.mjs deletes the retained previous-head CI failure inventory without a proven repair handoff; a fresh fixer reads live CI. Persist the inventory into the replacement fixer's handoff or dispatch brief before retiring. Also cover PR 6535: a record with pendingResume.kind=escalate and previousCi inventory stays excluded from fix-slot admission forever (logged delivered-previous-ci or resume-exhausted).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/await-verify-pass.test.mjs` with a new test: retiring an abandoned delivered wait writes the failure inventory into the replacement handoff; and a test that an escalate-kind record with previousCi inventory is released.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the stale window setting or the busy-session keep rule.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: inventory names are CI check names, fenced when put in a brief.
2. **Truncated reads** — an incomplete session listing keeps the wait.
3. **Shared state files** — compare-and-delete on the await-verify record.
4. **Fail closed** — a failed handoff write keeps the wait.
5. **Identity scoping** — keyed by session id and PR.
6. **State over time** — deliveredAt stamp with a policy-cascade window.
7. **Who wrote it** — n/a: records are written by the harness only.
