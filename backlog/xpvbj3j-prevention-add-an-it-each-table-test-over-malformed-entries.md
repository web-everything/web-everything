---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/push-gate-boundary.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add an it.each table test over malformed entries (bad status, short reason, sites 0, sites non-in… (from web-everything/web-everything#7420 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/push-gate-boundary.test.mjs:52` — Add an it.each table test over malformed entries (bad status, short reason, sites 0, sites non-integer) asserting `admit` throws. A longer-term option is a Stryker-style mutation gate on guard conditions in `scripts/lib` and `scripts/__tests__`.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7420@83e123bb42fcbc430a91c71a3dd7eec5ca52c4a2

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
