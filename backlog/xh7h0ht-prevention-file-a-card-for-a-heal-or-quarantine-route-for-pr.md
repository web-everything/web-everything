---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — File a card for a heal or quarantine route for probe-failed lanes during acquire, so a failed pro… (from web-everything/web-everything#7220 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-pool.mjs:1777` — File a card for a heal or quarantine route for probe-failed lanes during acquire, so a failed probe on one lane does not deadlock a pool whose other lanes are held.
2. `we:scripts/lane-pool.mjs:2643` — Make `laneDirtyOrAhead` callers use one helper that folds `probeFailed` into `dirty`, as `effectiveDirtyOrAhead` now does, and add a lint or test that no caller reads `.dirty` without `.probeFailed`.
3. `we:scripts/lane-pool.mjs:1294` — Record a metric or soak check for the share of ahead lanes that stop being recyclable after this strictness, and have scans refresh a lane's origin ref before judging it.
4. `we:scripts/lane-pool.mjs:1779` — Add a test with a lane `.git` that is unreadable (chmod 000 on the lane directory) and assert that growth and recovery are blocked. A lint for `catch` blocks that discriminate on `e.code` without a negative-case test would be a cheaper long-term guard.
5. `we:scripts/lane-pool.mjs:1783` — Add a negative test that makes `.git` unreadable (a chmod 000 parent, or a `.git` that is a directory without HEAD) and asserts acquire fails closed. More generally, write a test for each distinct branch of an error-code switch.
6. `we:scripts/lane-pool.mjs:1545` — Add a deterministic regression test with --force and failed snapshot evidence, asserting unchanged HEAD/files and zero reset/clean calls.
7. `we:scripts/lane-pool.mjs:1549` — Add a deterministic regression named 'refresh --force refuses unknown snapshot evidence' in we:scripts/__tests__/lane-pool-acquire-skips-unpushed.test.mjs, asserting unchanged HEAD and no reset/clean calls after a snapshot failure; require it to fail when the verdict guard is removed.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7220@583aa33913a0c98055a6c27dcce4f2cb9ce5cda1

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
