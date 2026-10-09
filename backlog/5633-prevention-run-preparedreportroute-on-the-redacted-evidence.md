---
bornAs: xhrc0su
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/prepare-failure-policy.mjs", "we:scripts/conveyor/__tests__/prepare-failure-policy.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Run preparedReportRoute on the redacted evidence, or pass holdReason through redactSpawnText. Add… (from web-everything/web-everything#4658 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/prepare-failure-policy.mjs:139` — Run `preparedReportRoute` on the redacted evidence, or pass `holdReason` through `redactSpawnText`. Add a test with a secret-shaped string in the worker report. A deterministic gate would be a standards rule that flags any ledger-record field written from `evidence` without `redactSpawnText`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4658@6ed9573b77714a07974a795b7d540724450b161b

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
