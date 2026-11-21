---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-state.mjs", "we:scripts/apply-review-request.mjs", "we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/lib/pr-state/holds/verdict.mjs", "we:scripts/lib/__tests__/pr-state.test.mjs", "we:scripts/__tests__/apply-review-request.test.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs", "we:scripts/lib/pr-state/holds/__tests__/verdict.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Make head a required argument of approvalValid and have callers pass null for "unknown". Add a un… (from web-everything/web-everything#7274 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-state.mjs:67` — Make `head` a required argument of `approvalValid` and have callers pass null for "unknown". Add a unit test for the unknown-head case on each caller.
2. `we:scripts/apply-review-request.mjs:132` — Share one `isFullHeadSha` predicate between `apply-review-request` and `review-set-label`. Add a test that an uppercase SHA is refused at validation.
3. `we:scripts/conveyor/pr-label-mirror.mjs:155` — File a card to source numeric event ids, for example from the REST timeline API. Until then, state the dead-branch status next to the acceptance bullet.
4. `we:scripts/lib/pr-state/holds/verdict.mjs:14` — Add a lint or standards check that every approvalValid call site passes a head argument, or make head required with an explicit 'legacy' sentinel. File it as a backlog item.
5. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring each Acceptance item to reference a named check, with a recorded result for required live proofs.
6. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring each acceptance criterion to reference a named test and, for live verification, a recorded result.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7274@581c0525a1c03b308ca614f03f9e0670df035c0b

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
