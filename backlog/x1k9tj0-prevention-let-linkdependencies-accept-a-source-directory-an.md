---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Let linkDependencies accept a source directory and test it against a synthetic one seeded with .v… (from web-everything/web-everything#7484 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/run.test.mjs:193` — Let `linkDependencies` accept a source directory and test it against a synthetic one seeded with `.vite`, `.cache` and one dependency. As a review lens: an absence assertion should first establish that the thing could have been present.
2. `we:scripts/operations/__tests__/run.test.mjs:197` — Let `linkDependencies` accept the source modules directory, and have the test pass a synthetic one containing `.vite`, `.cache` and a dummy package. Then assert that only the dummy package is linked. As a class guard, add a review lens: a test asserting absence must first create the thing it expects to be excluded.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7484@00c1b628dee4a4d4f8f3d39ca1b576326b6e7c28

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
