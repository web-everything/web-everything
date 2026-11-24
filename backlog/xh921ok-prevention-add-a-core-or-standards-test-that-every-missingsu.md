---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-smells/red-team-pending-overdue.mjs", "we:scripts/conveyor/health-smells/__tests__/red-team-pending-overdue.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a core or standards test that every missingSubjectsUnknown smell has a named test: a complete… (from web-everything/web-everything#7418 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-smells/red-team-pending-overdue.mjs:14` — Add a core or standards test that every `missingSubjectsUnknown` smell has a named test: a complete-inventory disappearance either closes the episode or is explicitly documented as never closing. Alternatively, have the probe emit explicit clear results for subjects missing from a complete inventory.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7418@8f8c1a034a49da37b320f469735842ef4a01bb10

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
