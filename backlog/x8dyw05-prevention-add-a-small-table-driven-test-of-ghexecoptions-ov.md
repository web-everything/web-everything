---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/gh-throttle-holders.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs", "we:scripts/lib/__tests__/gh-throttle-holders.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a small table-driven test of ghExecOptions over commands that are expected to be long-lived (… (from web-everything/web-everything#5326 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:2149` — Add a small table-driven test of `ghExecOptions` over commands that are expected to be long-lived (auth login, codespace ssh/logs -f). Alternatively let the shim opt out with `WE_GH_THROTTLE_MAX_HOLD_SECONDS=0` per invocation. Either one could be filed as a backlog item.
2. `we:scripts/lib/gh-throttle-holders.mjs:113` — Add a deterministic multiprocess test with a barrier after holder snapshots, then release simultaneous acquisitions and assert that successful reservations for one caller never exceed perCallerMax; serialize the caller-count check with reservation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5326@177c8290c328160402ce842546ef21be71f0a9d6

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
