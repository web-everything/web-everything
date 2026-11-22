---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-rotation.mjs", "we:scripts/lib/__tests__/provider-rotation.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a routeFor test table over policy states (undefined, invalid mode, shadow with bad body, on w… (from web-everything/web-everything#7338 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-rotation.mjs:186` — Add a routeFor test table over policy states (undefined, invalid mode, shadow with bad body, on with bad body) that states which ones must return legacyRoute. S1.2 wiring should also cover it with an integration test.
2. `we:scripts/lib/provider-rotation.mjs:134` — Make composePanel refuse (fail closed) any lens not in an explicit policy lens allow-list, with a unit test for case variants and unknown lenses. Also add a check:standards or schema rule requiring policy.keyLenses and the known lenses to be a closed enum.
3. `we:scripts/lib/provider-rotation.mjs:184` — Add a deterministic regression test using an unfrozen nested legacy route, asserting successful nested mutation after shadow routing.
4. `we:scripts/lib/provider-rotation.mjs:71` — Add a deterministic test passing mutable nested entry metadata and asserting it remains unfrozen and writable after effectiveShares; copy retained nested values or construct outputs from explicitly owned fields.
5. `we:scripts/lib/__tests__/provider-rotation.test.mjs:179` — Extend the named shadow-route test with mutable nested input and explicit post-call mutability assertions, enforced by the test suite.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7338@14bad3ea4822376f469ac8217f4fddbf4ae5483c

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
