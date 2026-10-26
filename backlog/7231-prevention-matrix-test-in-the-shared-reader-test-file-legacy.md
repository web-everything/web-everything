---
bornAs: xf4wsgl
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/record-red-team-ruling.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Matrix test in the shared-reader test file: {legacy, named} × {anyState on, off} × {live head, ca… (from web-everything/web-everything#5922 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/red-team-gate.mjs:638` — Matrix test in the shared-reader test file: {legacy, named} × {anyState on, off} × {live head, carried head}, asserting release or no release for each cell.
2. `we:scripts/lib/red-team-gate.mjs:637` — Run main's reader tests on the default path unchanged, and add a golden differential test (old vs new reader over a recorded-thread corpus with anyState off) so any default-mode delta is explicit.
3. `we:scripts/operations/record-red-team-ruling.mjs:117` — Parameterize the superseded-card test over both anyState values and require both cases to reject new filing while allowing an existing-card release in the automated test gate.
4. `we:scripts/lib/red-team-gate.mjs:645` — Add the reader-level regression test and a mutation gate removing the any-state explicit-result check.
5. `we:scripts/operations/record-red-team-ruling.mjs` — Run the duplicate-card regression test for both policy values and mutation-check each branch's carded filter.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5922@eb081852c9d1e2f3e44e2f533d60c7c4b3de725c

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
