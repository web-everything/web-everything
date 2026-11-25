---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci-timings-refresh.yml"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Have the PR-body prep check require each Acceptance clause to name a test or be marked as a live… (from web-everything/web-everything#7448 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci-timings-refresh.yml:3` — Have the PR-body prep check require each Acceptance clause to name a test or be marked as a live follow-up with an owner. No such gate was found or checked for, so it would need filing.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7448@96659769cd41b01102981a0644965d2ff3778f7c

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
