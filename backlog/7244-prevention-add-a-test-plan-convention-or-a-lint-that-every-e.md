---
bornAs: x8rtmi2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/record-red-team-ruling-io.mjs", "we:scripts/lib/operator-identity.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs", "we:scripts/operations/__tests__/record-red-team-ruling-io.test.mjs", "we:scripts/lib/__tests__/operator-identity.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Prevention — Add a test-plan convention, or a lint, that every effect sink in this file has a retry test: fail… (from web-everything/web-everything#5923 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/record-red-team-ruling-io.mjs:367` — Add a test-plan convention, or a lint, that every effect sink in this file has a retry test: fail the last write, retry, and assert event and post counts are unchanged. Better, share one 'ensure ledger intent' helper between the sinks.
2. `we:scripts/lib/operator-identity.mjs:20` — Add a table-driven test asserting every member of OPERATOR_GATE_OUTCOMES is dropped by operatorBoundComments when bot-authored. A new outcome then cannot be added without that coverage.
3. `we:scripts/operations/__tests__/record-red-team-ruling.test.mjs` — Add a deterministic integration test starting with review:human, exercising production label synchronization through injected transport, and asserting that the label remains after a not-real ruling.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5923@c77d6d2202b29f0701ab71b8fde8a2574aafae30

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
