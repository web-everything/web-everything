---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/fix-dispatch-claim.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs", "we:scripts/conveyor/__tests__/fix-dispatch-claim.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a table-driven test over old-terminal-row cases to the stale-release suite, asserting release… (from web-everything/web-everything#7271 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/fix-dispatch-claim.mjs:436` — Add a table-driven test over old-terminal-row cases to the stale-release suite, asserting release when no row is bound to the claim's sessionId or started at/after claimedAt. Alternatively, add a soak case with a historical terminal row.
2. `we:scripts/conveyor/fix-dispatch-claim.mjs:594` — Add a test asserting that a verified-live owner (identity alive and heartbeat refreshed) emits no quarantine event, or dedupe quarantine events per claim.
3. `we:scripts/conveyor/fix-dispatch-claim.mjs:330` — Add a test that mocks defaultListAgents to [] and listWrappedWorkerAgents to a non-empty unrelated row, and asserts a stale claim is retained. Or require non-empty evidence from the claude source specifically. Hardening beyond internal-delivery level should be filed as a card.
4. `we:scripts/conveyor/__tests__/fix-dispatch-claim-stale-release.test.mjs:1` — Parameterise the main release test over ['fix','ci-heal'] and add a negative case for 'fixing'.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7271@ee7c00684174bc02e8d375799fd0022690893d95

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
