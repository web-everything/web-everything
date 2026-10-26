---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Either drop the env opt-in (keep only the opt-out, which is fail-safe), or record the effective s… (from web-everything/web-everything#5922 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-gate.mjs:634` — Either drop the env opt-in (keep only the opt-out, which is fail-safe), or record the effective scope in the release record so every reader judges the record by the scope it was posted under. Add a test that reads the same thread with default `readRedTeamDisposition` (no `operatorRulings`) and with env-only opt-in.
2. `we:scripts/lib/red-team-gate.mjs:651` — Add a mutation or coverage gate (e.g. a Stryker or branch-coverage check on `we:scripts/lib/red-team-gate.mjs`) so that an unexercised conditional operand fails the lane. At minimum, parametrize the `operatorReleaseLines` tests over `anyState` and over a null versus a named result id.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5922@5e8db56777b1a770ea35c1f94bfef6628cd3ed05

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
