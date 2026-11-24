---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/__tests__/ci-log-unreadable.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Require an Acceptance bullet that is not unit-testable to name a follow-up check, such as a post-… (from web-everything/web-everything#7449 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-pass.mjs:2239` — Require an Acceptance bullet that is not unit-testable to name a follow-up check, such as a post-deploy daemon-log query, in the card.
2. `we:scripts/conveyor/reconcile-pass.mjs:2239` — Add a test that derives the guard from gh's refusal set. Alternatively, make the guard stricter by refusing any C0/C1 control character except \t, \n and \r. Backlog the gate as 'fail-closed guard must be a superset of the transport's permitted bytes'.
3. `we:scripts/conveyor/__tests__/ci-log-unreadable.test.mjs:46` — A per-alternative table-driven test for the guard regex.
4. `(no file cited)` — Add an acceptance-to-verification gate requiring a named automated or operational check for every acceptance item. This guard needs a future backlog item; it could not be filed from this read-only review.
5. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring each acceptance guarantee to reference a named test or measurement, with an explicit assertion and observation window for live metrics.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7449@323dea7368c53d0952069f1001a7d81b2c6263b2

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
