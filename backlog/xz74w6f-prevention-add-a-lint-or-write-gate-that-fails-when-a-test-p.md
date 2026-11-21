---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/__tests__/adopt-then-add.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a lint or write-gate that fails when a test passes options that the function under test does… (from web-everything/web-everything#7171 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/__tests__/adopt-then-add.test.mjs:36` — Add a lint or write-gate that fails when a test passes options that the function under test does not declare. Reword the PR Acceptance to the shipped scope.
2. `we:scripts/lib/daemon-rebuild/__tests__/adopt-then-add.test.mjs:39` — Require each Acceptance clause to reference a named test and its observable assertion, with a deterministic check that each referenced test exists.
3. `we:scripts/lib/daemon-rebuild/__tests__/adopt-then-add.test.mjs:42` — Gate Acceptance mappings on existing named tests and require explicit non-default fixtures for dependency guarantees.
4. `we:scripts/lib/daemon-rebuild/__tests__/adopt-then-add.test.mjs:37` — Require each Acceptance guarantee to reference a named test with an observable assertion matching its promised outcome.
5. `we:scripts/lib/daemon-rebuild/__tests__/adopt-then-add.test.mjs` — Gate Acceptance coverage on named test mappings, including a dependency-bearing negative case for this adoption path.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7171@477cda07f0053607ceeff231521acb582cffda87

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
