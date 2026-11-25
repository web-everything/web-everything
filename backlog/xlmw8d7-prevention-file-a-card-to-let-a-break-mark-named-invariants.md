---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs", "we:scripts/operations/__tests__/review-job-expected-head.test.mjs", "we:scripts/operations/review-dispatch.mjs", "we:scripts/conveyor/soak/breaks/__tests__/review-dispatch-without-expected-head.test.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — File a card to let a break mark named invariants as temporarily expected to fail while the rest s… (from web-everything/web-everything#7472 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs:150` — File a card to let a break mark named invariants as temporarily expected to fail while the rest stay required, or have the break filter only `session-head-admission` direct/missing and `land-advance-head-admission` under the marker.
2. `we:scripts/operations/__tests__/review-job-expected-head.test.mjs:50` — File with SMOKE-GUARD-RELAND: a test that runs the previous harness's exact dispatchReview argument shape, or its dry-run script, against the candidate tree.
3. `we:scripts/operations/review-dispatch.mjs:642` — File the card now, including removal of the soak marker; add a standards check that every `TEMPORARY (<ID>)` marker resolves to an open backlog card.
4. `we:scripts/operations/review-dispatch.mjs:585` — Review lens: a change to a guard flag also updates the parameter documentation; SMOKE-GUARD-RELAND restores the claim.
5. `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs:150` — A deterministic check that rejects a `fixPresent` which returns false for a fix already in git ancestry, so temporary relaxations must be made per invariant (for example, an explicit `pendingInvariants` list that `judge` filters).
6. `we:scripts/operations/__tests__/review-job-expected-head.test.mjs:50` — A compatibility test that runs the previous harness's dispatch-dry-run script against the candidate tree; file it with SMOKE-GUARD-RELAND.
7. `we:scripts/operations/review-dispatch.mjs:645` — A standards check requiring every `TEMPORARY (<ID>)` marker to resolve to an open backlog card; file the SMOKE-GUARD-RELAND card.
8. `we:scripts/operations/review-dispatch.mjs:585` — A review-lens check that guard-flag changes update the parameter docs; no cheap deterministic gate fits.
9. `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs:150` — Add a deterministic test covering marker presence, marker removal, and ancestry outcomes for fixPresent.
10. `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs:150` — Keep retained invariants in normally passing named tests, isolate the temporary missing-head expectations, and add a deterministic mutation check demonstrating that a provided-stale-head regression still fails the soak gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7472@50cdbd2c73036272f775cbef41be1b517e1241ae

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
