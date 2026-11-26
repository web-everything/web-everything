---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xq7478t-name-forge-net-diff-follow-up-tests.md"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Implement the named opt-in live test and add an acceptance-to-test check requiring referenced tes… (from web-everything/web-everything#7478 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xq7478t-name-forge-net-diff-follow-up-tests.md:26` — Implement the named opt-in live test and add an acceptance-to-test check requiring referenced test cases to exist. The live-test follow-up is already filed in xq7478t.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7478@c3372939231025a6cec82370a16808cba6df0dc0

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
