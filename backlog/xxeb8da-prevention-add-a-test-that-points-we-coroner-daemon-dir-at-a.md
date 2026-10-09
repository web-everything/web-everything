---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/coroner-extract.mjs", "we:scripts/operations/__tests__/coroner-extract.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a test that points WE_CORONER_DAEMON_DIR at an empty directory and asserts either a no-live-s… (from web-everything/web-everything#4711 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/coroner-extract.mjs:829` — Add a test that points WE_CORONER_DAEMON_DIR at an empty directory and asserts either a no-live-source warning or a documented exemption. Alternatively, drop the env exemption and have the tests write their logs.
2. `we:scripts/operations/coroner-extract.mjs:829` — Add a deterministic parameterized test requiring no-live-source for missing logs and rotations across plist, environment, and registry resolution.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4711@dde3981218a8db7387ac4630b5b6c2fd2d3ce630

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
