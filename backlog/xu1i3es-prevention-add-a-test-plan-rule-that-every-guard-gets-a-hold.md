---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/orphan-fix-round.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/orphan-fix-round.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a test-plan rule that every guard gets a hold test and an allow test per clause, plus a wirin… (from web-everything/web-everything#7576 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2065` — Add a test-plan rule that every guard gets a hold test and an allow test per clause, plus a wiring check that a new optional guard parameter has at least one non-test caller. Prefer a deterministic check:standards rule that flags exported options with no non-test call site.
2. `we:scripts/conveyor/orphan-fix-round.mjs:214` — File a card to cross-check the listing with a second pass, or with a count of open PRs. Alternatively use cursor or ID-bounded paging. A deterministic test with an injected mid-scan removal would pin it.
3. `we:scripts/conveyor/orphan-fix-round.mjs:489` — Expose `listingComplete` separately from processing status, and add a test asserting the consumer's behaviour on redispatch-cap and processing-deadline. This should be settled when the daemon wiring card lands.
4. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2065` — Add a deterministic check:standards rule or integration test: any new guard parameter on `runReconcileFixDispatch` must be passed at every non-test call site. Alternatively, make the parameter required and fail closed when it is absent.
5. `we:scripts/conveyor/orphan-fix-round.mjs:240` — Add a mutation or branch-coverage gate on the new listing function, so each early-return `incomplete(...)` reason must be hit by at least one named test.
6. `we:scripts/conveyor/orphan-fix-round.mjs:249` — Add the named deterministic regression test with a short response that advances the clock beyond the deadline.
7. `we:scripts/conveyor/orphan-fix-round.mjs:195` — Add deterministic tests inspecting subprocess options as the clock advances and testing cursor lengths immediately below and above the limit.
8. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2065` — Add a deterministic daemon integration test that produces an incomplete listing through the production call path and asserts reconciliation and dispatch are never invoked.
9. `we:scripts/conveyor/orphan-fix-round.mjs:247` — Add a deterministic terminal-page deadline test asserting complete:false and listing-deadline, and mutation-check removal of the post-request guard.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7576@de0b220f0907aa131d82324bc7abff76083d0a32

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
