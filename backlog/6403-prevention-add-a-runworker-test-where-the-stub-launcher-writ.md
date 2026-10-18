---
bornAs: xgr7ouk
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a runWorker test where the stub launcher writes to stderr after the JSON report and assert la… (from web-everything/web-everything#5486 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/probation-build-run.mjs:984` — Add a `runWorker` test where the stub launcher writes to stderr after the JSON report and assert `lastMessage` is still recovered. Better, build `out` as `stdout` on success and append `stderr` only on failure, matching `trySh`.
2. `we:scripts/operations/review-loop-cli.mjs:451` — A table-driven test over every combination of the `seatsByTouchSet` and `cardOnly.lightLane` settings, with the precedence documented in we:docs/agent/testing.md. Any new roster-reducing setting would be reviewed against the existing off-switches.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5486@be5c87d2596c6f0fb8b356cf66cd6d65d20767aa

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
