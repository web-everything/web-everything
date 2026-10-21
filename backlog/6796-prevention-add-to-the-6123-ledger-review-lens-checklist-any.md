---
bornAs: xrz7i3t
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6121-card-number-ledger-shadow.md", "we:backlog/6124-card-number-ledger-readers.md"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add to the 6123 ledger review-lens checklist: any trust anchor that is a commit must be asserted… (from web-everything/web-everything#5245 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6121-card-number-ledger-shadow.md:30` — Add to the 6123 ledger review-lens checklist: any trust anchor that is a commit must be asserted as an ancestor of the tip, with a named non-ancestor fixture. Put the fixture in slice (a)'s required tests.
2. `we:backlog/6124-card-number-ledger-readers.md:23` — Add an architecture test requiring both ledger adapters to delegate verification to one shared core, alongside the planned common fixtures.
3. `we:backlog/6124-card-number-ledger-readers.md:83` — Add a deterministic rename-transition fixture that records all pre-rename public routes and asserts that each still resolves after materialization; require it in reader and batch acceptance.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5245@b96021d1e5a188753f8558e4a814a15ad5afba2f

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
