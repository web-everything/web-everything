---
bornAs: x5u5maj
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-gate.mjs", "we:scripts/lib/ci-heal-reserve.mjs", "we:scripts/lib/resource-admission.mjs", "we:scripts/lib/__tests__/resource-gate.test.mjs", "we:scripts/lib/__tests__/ci-heal-reserve.test.mjs", "we:scripts/lib/__tests__/resource-admission.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Have the throttle load the cascaded policy once per pass and pass it to both decideFixCap and the… (from web-everything/web-everything#4788 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-gate.mjs:196` — Have the throttle load the cascaded policy once per pass and pass it to both decideFixCap and the gate. Add a test with an overridden fix threshold.
2. `we:scripts/lib/ci-heal-reserve.mjs:23` — Memoize loadResourceGateSettings per process or per pass, or resolve it once in the createCiHealReserve and createFixBorrowGate factories.
3. `we:scripts/lib/resource-gate.mjs:110` — Add a test per Must/fail-closed line in the card's Test plan, and make the backlog check require a named test file and case for each Must line.
4. `we:scripts/lib/resource-admission.mjs:52` — Add a check:standards rule that a diff changing a function's default-param or error-handling behaviour must touch a test file for that module.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4788@f8f76322f66162e67f4b1c4eb52f097aea8465f9

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
