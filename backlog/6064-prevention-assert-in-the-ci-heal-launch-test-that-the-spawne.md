---
bornAs: x4erwmp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/conveyor/fix-loop-ledger.mjs", "we:scripts/conveyor/stale-base-refresh.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs", "we:scripts/conveyor/__tests__/fix-loop-ledger.test.mjs", "we:scripts/conveyor/__tests__/stale-base-refresh.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Assert in the ci-heal launch test that the spawned prompt omits the 'authoritative ask' sentence.… (from web-everything/web-everything#5185 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/fix-run.mjs` — Assert in the ci-heal launch test that the spawned prompt omits the 'authoritative ask' sentence. Better, build the ci-heal preamble from a separate constant so no regex is involved.
2. `we:scripts/conveyor/fix-loop-ledger.mjs` — Add a test for aggregate infraFailures combined with a ledger outcome and no infraRows, asserting `until` and the build-change rearm.
3. `we:scripts/conveyor/stale-base-refresh.mjs` — Persist an attempt reservation durably before refresh and add a deterministic regression test that invokes the gate again after both refresh and marker posting fail, asserting that refresh is called only once for that base.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5185@d1670db4c6790c1832a9ba18bb30a13f90564489

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
