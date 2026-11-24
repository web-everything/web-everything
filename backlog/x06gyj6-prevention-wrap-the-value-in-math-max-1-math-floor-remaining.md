---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/urgent-verify.mjs", "we:scripts/operations/__tests__/urgent-verify.test.mjs", "we:scripts/__tests__/lane-pool-hooks-path.test.mjs", "we:scripts/readiness/__tests__/git-bundle-transport.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Wrap the value in Math.max(1, Math.floor(remaining)) when computing remaining, and add a unit tes… (from web-everything/web-everything#7455 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/urgent-verify.mjs:59` — Wrap the value in `Math.max(1, Math.floor(remaining))` when computing `remaining`, and add a unit test that feeds a fractional limit.
2. `we:scripts/operations/urgent-verify.mjs:58` — Add a test that runs the isolate path with a decorated or mocked spawnSync and asserts that a second step's timeout is smaller than the first step's. File it as a backlog card.
3. `we:scripts/operations/__tests__/urgent-verify.test.mjs:1000` — Add a table-driven test for the result-line markers and a test for the non-group shard timeout. File as a backlog item.
4. `we:scripts/operations/urgent-verify.mjs:66` — Add a table-driven test over pid values (0, 1, undefined, NaN, negative) asserting `process.kill` is never called.
5. `we:scripts/operations/urgent-verify.mjs:16` — Use `Math.max(1, Math.floor(remaining))` when passing the timeout, and add a test with maxMinutes: 4.1.
6. `we:scripts/operations/urgent-verify.mjs:18` — Add the named environment-override regression test to the automated suite, using a value distinct from the default.
7. `we:scripts/operations/urgent-verify.mjs:124` — Gate deadline propagation with the named deterministic regression test using a controlled clock.
8. `we:scripts/__tests__/lane-pool-hooks-path.test.mjs:228` — Add a deterministic standards check, with the named regression case, requiring finite positive timeouts on these synchronous hash-object stdin spawns.
9. `we:scripts/operations/urgent-verify.mjs:191` — Add a deterministic regression test with suffix-overlapping assigned paths and assert that the unfinished path remains in hungFiles.
10. `we:scripts/operations/__tests__/urgent-verify.test.mjs:975` — Add a fake-clock regression test that advances time before isolation and verifies both scoped and subsequent commands use the original deadline.
11. `we:scripts/readiness/__tests__/git-bundle-transport.test.mjs:571` — Add a deterministic AST-based test or standards gate requiring bounded timeout and SIGKILL options on both hash-object stdin calls.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7455@0d6099564af212e1cba185f1cee1ec189ed00d2c

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
