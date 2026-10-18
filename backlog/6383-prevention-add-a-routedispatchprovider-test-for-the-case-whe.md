---
bornAs: xe8mwpy
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a routeDispatchProvider test for the case where the probation decision is launch but the prob… (from web-everything/web-everything#5258 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/dispatch-lane-io.mjs:1806` — Add a routeDispatchProvider test for the case where the probation decision is launch but the probation script is missing and the registry route exists. It should assert that a `notApplied` error is thrown.
2. `we:scripts/operations/dispatch-lane-io.mjs:1774` — Add a deterministic integration test that passes the default repair routing result into the launcher and asserts Sol, Astra, then Claude after definite refusals.
3. `we:scripts/operations/dispatch-lane-io.mjs:1778` — Add a launch-boundary regression test for protected escalation routes and restrict ordinary repair overlays so they preserve explicit escalation selections.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5258@9d9df12d002272fd49143e08c0da777c7d06c9a9

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
