---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs", "we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Parameterise the release tests over ['fix','ci-heal'] with it.each. A claim-kind enumeration test… (from web-everything/web-everything#7271 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs:14` — Parameterise the release tests over ['fix','ci-heal'] with it.each. A claim-kind enumeration test that fails when a new kind has no release case would cover the whole class.
2. `we:scripts/conveyor/fix-dispatch-claim.mjs:594` — Add a test that a live, identity-verified owner emits no quarantine event, or dedupe the event per claim. Put the event kind's semantics in the event catalogue.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7271@ab2e110efc9141bdd4a380afc805a0912f06b1b0

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
