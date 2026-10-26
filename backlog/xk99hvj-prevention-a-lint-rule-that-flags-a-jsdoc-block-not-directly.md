---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/record-red-team-ruling-io.mjs", "we:scripts/lib/operator-identity.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs", "we:scripts/operations/__tests__/record-red-team-ruling-io.test.mjs", "we:scripts/lib/__tests__/operator-identity.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — A lint rule that flags a JSDoc block not directly followed by the declaration it describes. (from web-everything/web-everything#5923 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-gate.mjs:529` — A lint rule that flags a JSDoc block not directly followed by the declaration it describes.
2. `we:scripts/operations/record-red-team-ruling-io.mjs:415` — File a follow-up card for a repair path, for example a ledger-backfill step or a retryable `ledgerWriteMiss` marker. Otherwise make the PR description say block's ledger miss is warn-only.
3. `we:scripts/lib/operator-identity.mjs:20` — Add a test that iterates OPERATOR_GATE_OUTCOMES and asserts that each outcome authored by the bot account is dropped by operatorBoundComments. A future outcome would then be covered automatically.
4. `we:scripts/operations/record-red-team-ruling-io.mjs:395` — Route every subprocess the sinks spawn through a single operator-env wrapper, and add a lint or test that asserts the sinks never call `execFileSync` or `spawnSync` without an explicit `env`.
5. `we:scripts/operations/__tests__/record-red-team-ruling.test.mjs` — Extend the named test with two held findings and review:human, rule only one not-real, and assert the other remains held and review:human remains present using the actual label synchronization behavior.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5923@cd1c3041b01d662ed9c3a5e7c6135bc89074b709

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
