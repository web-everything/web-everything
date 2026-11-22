---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/codex-direct-task.test.mjs", "we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a spawned-CLI test using a running-job fixture, with --until-done --overall-ms=250 expecting… (from web-everything/web-everything#7335 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/codex-direct-task.test.mjs:1897` — Add a spawned-CLI test using a running-job fixture, with `--until-done --overall-ms=250` expecting exit 75 and the timeout message on stderr. Add one for `--overall-ms=abc` expecting exit 2. A reviewer lens that asks 'does the fixture distinguish the new code path from the default path' would also catch this.
2. `we:scripts/__tests__/codex-direct-task.test.mjs:1760` — Add a `waitUntilDone` rejection test for invalid `sliceMs`. Longer term, add a lint or review rule that every flag listed in help text has a named usage-error test.
3. `we:scripts/__tests__/codex-direct-task.test.mjs:1900` — Add a spawned-CLI test for `wait --until-done --overall-ms=250` against a running job that expects exit 75, and one for an invalid `--overall-ms` that expects exit 2. The test-plan template should require a CLI exit-code test for each documented exit code.
4. `we:scripts/__tests__/codex-direct-task.test.mjs:1900` — Add a deterministic CLI integration test in we:scripts/__tests__/codex-direct-task.test.mjs asserting multiple slices, supplied budgets, stderr heartbeats, and a single final stdout JSON result.
5. `we:scripts/codex-direct-task.mjs:1709` — Add a deterministic fake-clock test in we:scripts/__tests__/codex-direct-task.test.mjs that omits overallMs and asserts the accumulated slice budget equals 3000000 ms before returning code 75.
6. `we:scripts/codex-direct-task.mjs:1724` — Add a deterministic boundary test covering overall budgets below, at, and just above the minimum slice duration.
7. `we:scripts/__tests__/codex-direct-task.test.mjs:1900` — Gate on a CLI integration test that observes a running heartbeat on stderr, continued process execution, and eventual terminal JSON and exit status using explicit slice and overall budgets.
8. `we:scripts/codex-direct-task.mjs:1709` — Add a deterministic fake-clock test omitting overallMs and asserting cumulative requested wait time equals 3000000 ms before timeout.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7335@a91e50b2e3874dcec1526ec397bbd5e14d8d8998

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
