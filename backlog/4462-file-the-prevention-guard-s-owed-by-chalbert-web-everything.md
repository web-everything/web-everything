---
bornAs: xbsa9by
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs", "we:scripts/conveyor/soak/breaks/already-done-burst-unattributed.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/already-done-burst-unattributed.test.mjs"]
dateOpened: "2026-09-29"
dateResolved: "2026-10-09"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2911's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/dispatch-lane-io.mjs:2900` — Add a bounded-concurrency cap or a per-pass count/time budget in dispatch-plan's already-done pass, and add a soak assertion on total wall time for N=100. Update the stale 'non-blocking' comment. Longer term, give gh-throttle a real async, non-blocking API.
2. `we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs:455` — Use vi.stubEnv or a save/restore helper (or afterEach cleanup) for env mutation in tests.
3. `we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs` — Use the ESLint `no-restricted-imports` rule to ban `execFile` from `node:child_process` codebase-wide instead of brittle regex testing.
4. `we:scripts/conveyor/soak/breaks/already-done-burst-unattributed.mjs` — A review lens demanding exact quantification in array assertions ('assert the number, not just non-empty').
5. `we:scripts/operations/__tests__/dispatch-lane-defaults.test.mjs` — A `check:standards` AST rule that verifies all exported functions in IO modules with an `exec` parameter default to a throttled variant.
6. `we:scripts/operations/dispatch-lane-io.mjs` — A lint rule forbidding the use of `execFileSync` inside an `async function` unless explicitly wrapped in a Worker.
7. `we:scripts/operations/dispatch-lane-io.mjs:2898` — An architectural lint rule (e.g. a custom AST check in `check:standards`) forbidding the use of synchronous `child_process` methods inside `async` functions.
8. `we:scripts/operations/dispatch-lane-io.mjs:266` — A runtime guard inside `execFileSyncThrottled` that throws an invariant violation if the `file` argument is not `gh`, ensuring the GitHub throttle only ever wraps GitHub calls.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2911@525e3175ca4dc11952824ed7cb00f952ab97098d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
