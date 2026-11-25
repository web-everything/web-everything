---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-handover.mjs", "we:scripts/operations/__tests__/daemon-host-gate-swap.test.mjs", "we:scripts/lib/__tests__/daemon-handover.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — When S1.3/S1.4 wire the validator, add a gate test that fails if the call site omits any of gen,… (from web-everything/web-everything#7503 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-handover.mjs:33` — When S1.3/S1.4 wire the validator, add a gate test that fails if the call site omits any of gen, codeDigest or pid. Or make the expected values required parameters.
2. `we:scripts/operations/__tests__/daemon-host-gate-swap.test.mjs:167` — Add a parameterised test that sends SIGTERM, SIGINT and SIGHUP to both a candidate and a promoted green, then asserts the first kill signal. Review lens: a comment that says 'even after X' needs a test that does X.
3. `we:scripts/operations/__tests__/daemon-host-gate-swap.test.mjs:96` — Assert `expect(h.spawns[0].opts).toEqual({stdio:'inherit', detached:true})` in the setting-off test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7503@5f93828fb33a0e8cd266c29be154bb746f95bb39

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
