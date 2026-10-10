---
bornAs: xt5s7iz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/__tests__/stand-down.test.mjs", "we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test that runs a redispatched PR through the health smells (stood-down-prs, review-label-co… (from web-everything/web-everything#4700 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/stand-down.mjs:278` — Add a test that runs a redispatched PR through the health smells (stood-down-prs, review-label-conflict). Better, have the quiet-host pass remove the stood-down label when it posts `redispatched`.
2. `we:scripts/conveyor/load-flake-reverify.mjs:320` — After the sweep loop, exit non-zero (after printing the JSON) if any repo recorded an `error`. Add a CLI test asserting a non-zero status for the failing-repo fixture.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4700@858dca891598c271d4d2cea51bf14c1e3cacb149

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
