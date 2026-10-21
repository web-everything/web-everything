---
bornAs: xw00y7y
kind: story
size: 3
status: open
scope: ["we:scripts/operations/", "we:scripts/readiness/"]
dateOpened: "2026-10-18"
tags: []
---

# proto-test: affected-tests step for prototype branches

Prototype test step (operator 2026-10-18). Add a product step proto-test, a declared operation under we:scripts/operations/, that derives the affected tests for a prototype branch vs its base: the changed files plus the tests that import them, via vitest related. It always runs them through we:scripts/readiness/heavy-admission.mjs in one call. Drivers never hand-pick test files or run the whole suite. The full suite is left to CI on the graduation PRs. It records the duration of each test file and flags files over a cascade setting protoTest.slowFileSec (default 30, source logged) for splitting. Live example: we:scripts/__tests__/review-set-label.test.mjs took 62 s. Evidence: on 2026-10-18 an integrator driver spent more than 1 h running the whole suite file by file, hand-chunked, because no such step existed. Complements card x2bm019 (backlog/6410, not yet on main).

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
