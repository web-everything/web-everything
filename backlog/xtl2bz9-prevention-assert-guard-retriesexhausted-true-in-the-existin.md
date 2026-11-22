---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs", "we:scripts/lib/__tests__/drain-queue-safety.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Assert guard.retriesExhausted === true in the existing update-branch-refused test in we:drain-que… (from web-everything/web-everything#7343 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-queue-safety.mjs` — Assert guard.retriesExhausted === true in the existing update-branch-refused test in we:drain-queue-safety.test.mjs (around line 792).
2. `we:scripts/lib/drain-queue-safety.mjs:420` — Add a mutation-style test for each fail-closed catch in the refresh ledger path. A lint that flags catch blocks setting a *Unreadable flag with no test referencing them would also work.
3. `we:scripts/lib/drain-queue-safety.mjs:328` — Add a deterministic boundary test asserting actual GitHub call counts for 1,000 checks, ten failed jobs, and inputs exceeding either bound.
4. `(no file cited)` — Require each Acceptance entry to reference a named automated test or reproducible verification procedure with its recorded result.
5. `we:scripts/lib/drain-queue-safety.mjs` — Add a deterministic regression test distinguishing an author-created merge from an update-branch successor, and bind generated successors using refresh provenance rather than parent shape alone.
6. `(no file cited)` — Require each Acceptance entry to reference a named test or recorded verification procedure, enforced by an acceptance-to-test manifest check.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7343@5b681379794a4c95331ab5f51d38fad4c2c7acd3

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
