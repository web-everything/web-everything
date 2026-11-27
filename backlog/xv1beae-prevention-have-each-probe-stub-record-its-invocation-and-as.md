---
kind: story
size: 3
status: open
scope: ["we:scripts/__tests__/lane-pool-cross-pool.test.mjs", "we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Have each probe stub record its invocation and assert an empty invocation log in the named refusa… (from web-everything/web-everything#7608 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#7608's review (reviewed head `8a9e0c9c00cc66c24cd0515faa1f6f1288fb2833`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/__tests__/lane-pool-cross-pool.test.mjs:223` — Have each probe stub record its invocation and assert an empty invocation log in the named refusal test.
2. `we:scripts/lane-pool.mjs:536` — Add a deterministic Git-shim test that changes the returned origin between qualification and recursive resolution, asserting the origin-changed refusal and no clone, fetch, push, or pool mutation.
3. `we:scripts/lane-pool.mjs:6163` — Add a check:standards lint that flags interpolating `originUrl` or `remote get-url` output into log/fail/console calls without `redactUrlCredentials`.
4. `we:scripts/lane-pool.mjs:534` — Have the review gate list `fail(...)` branches newly added in the diff that no test asserts by message text, with a lint on untested new refusal strings.
5. `we:scripts/__tests__/lane-pool-cross-pool.test.mjs:217` — Add a test-lint or review lens that treats 'before X' or 'never X' comments in tests as needing a recorded-call assertion. Cheapest fix: assert the wrong-origin `refused()` helper's `calls` contains no `stub ` lines.
6. `we:scripts/__tests__/lane-pool-cross-pool.test.mjs:217` — Extend the named test with invocation-recording stubs and an assertion that forbidden probes were never called.
7. `we:scripts/lane-pool.mjs:534` — Add a deterministic parameterized CLI test whose Git shim changes origin or ownership after qualification and asserts refusal before network or lane effects.
8. `we:scripts/__tests__/lane-pool-cross-pool.test.mjs:217` — Make each probe stub append its invocation to a log and assert the log remains empty in this test, providing a deterministic regression gate for the stated ordering guarantee.

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
