---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-scope-fence-io.mjs", "we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence-io.test.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Add a lint or standards rule that every numeric limit named in we:docs/agent/testing.md maps to a… (from web-everything/web-everything#5461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-scope-fence-io.mjs:23` — Add a lint or standards rule that every numeric limit named in we:docs/agent/testing.md maps to a named test. Failing that, require one test per limit constant (FENCE_READ_TIMEOUT, FENCE_MAX_GIT_READS, FENCE_MAX_BUFFER).
2. `we:scripts/conveyor/await-verify-pass.mjs:396` — Review lens: any new persisted record field needs a test that reads it back on a later tick.
3. `we:scripts/conveyor/fix-scope-fence-io.mjs:28` — Give `readDiff`/`budgetGh` an injectable `now`/clock, then add a deadline-expiry test and an `E2BIG` test next to the existing ENOBUFS and budget tests. Longer term, a lint or standards rule could require each documented bound constant to be referenced by a test.
4. `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` — Add a deterministic fake-clock test that exhausts the shared deadline below the command limit and checks refusal, terminal classification, and stand-down.
5. `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` — Add a table-driven cascade gate testing each field at every winning layer with contrasting lower-layer values, asserting both the resolved value and its source.
6. `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` — Add the distinguishing integration test to the required test gate, with card scope containing only we:guard.mjs and the fallback additionally containing we:outside.mjs.
7. `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` — Add a deterministic clock-controlled deadline test to the required test gate, exhausting elapsed time while remaining below the command budget.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5461@ff45ed96c40644e5537370df84b6b30328b1a73e

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
