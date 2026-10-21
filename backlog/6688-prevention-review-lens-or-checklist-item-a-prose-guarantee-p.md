---
bornAs: x0y10rw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tools/drain-daemon/lib.test.mjs", "we:tools/drain-daemon/lib.mjs", "we:tools/drain-daemon/daemon.mjs", "we:tools/drain-daemon/__tests__/lib.test.mjs", "we:tools/drain-daemon/__tests__/daemon.test.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# Prevention — Review lens or checklist item: a prose guarantee ("preserved", "never", "fails closed") needs a mutation-… (from plateauapp/plateau-app#226 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tools/drain-daemon/lib.test.mjs:2425` — Review lens or checklist item: a prose guarantee ("preserved", "never", "fails closed") needs a mutation-checked test. Cheapest: a `check:standards` rule that requires a named test file reference for each exported IO helper. This case is a simple test that mutates the lock inside the injected probe.
2. `we:tools/drain-daemon/lib.mjs:119` — Add an injectable `spawn` parameter to `processProbe` / `listGitCwds`, plus fixture-driven tests of lsof/ps output and failure shapes. Longer term, a standards check that every function claiming "fail closed" has a test importing it.
3. `we:tools/drain-daemon/lib.test.mjs:2398` — Extract the ps/lsof output parsing and error classification into pure functions that take captured output and test them with fixtures. Add a check:standards rule requiring a named test for each exported or injected safety-gate default.
4. `we:tools/drain-daemon/lib.test.mjs:2398` — Add a review-checklist or lint rule that every `return { cleared: false }` fail-closed branch in the helper has a named test. Alternatively, run a mutation-testing gate on the safety helpers.
5. `we:tools/drain-daemon/lib.mjs:107` — Add deterministic tests mocking spawnSync responses through the production probes, asserting that uncertain results and matching git targets preserve the lock.
6. `we:tools/drain-daemon/lib.mjs:158` — Add deterministic tests that replace or touch the lock inside an injected holder probe, then assert preservation; require these tests in the existing test gate.
7. `we:tools/drain-daemon/daemon.mjs:385` — Use non-default thresholds in deterministic wiring tests, assert recovery arguments, and assert alert timing at the configured boundary.
8. `we:tools/drain-daemon/lib.mjs:107` — Add deterministic subprocess-result fixtures covering production probe parsing and failure classification, and run them in the required test gate.
9. `we:tools/drain-daemon/lib.mjs:162` — Use the injected holder probes to deterministically replace or touch the lock during tests, with mandatory preservation assertions in CI.
10. `we:tools/drain-daemon/lib.test.mjs:2480` — Require non-default sentinel values in configuration-wiring tests and assert observable threshold behavior in the test gate.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#226@13dcd3268f54d97d623a91993b087a51bd74fc93

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
