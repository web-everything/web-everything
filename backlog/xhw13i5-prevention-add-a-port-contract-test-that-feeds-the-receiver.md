---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/forge-adapter/change-events.mjs", "we:scripts/lib/forge-adapter/__tests__/change-events.test.mjs", "we:scripts/lib/pr-event-feed.mjs", "we:scripts/conveyor/pr-events-worker/__tests__/app-webhook.test.mjs", "we:scripts/lib/__tests__/pr-event-feed.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a port contract test that feeds the receiver's real envelope shapes (reset, gap, contiguous,… (from web-everything/web-everything#7459 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/forge-adapter/change-events.mjs:19` — Add a port contract test that feeds the receiver's real envelope shapes (reset, gap, contiguous, empty) through readChangeEvents. Better still, drive the port tests from log.read output.
2. `we:scripts/lib/forge-adapter/__tests__/change-events.test.mjs:66` — Add a check:standards import-boundary rule: core modules may import only forge-adapter ports, never forge-adapter/github/* or worker parse functions.
3. `we:scripts/lib/forge-adapter/__tests__/change-events.test.mjs:65` — Add a deterministic test that drives `createFeedConsumer` with the default `poll` against a stub fetch returning a skipped seq. Back it with a lint rule forbidding `pollEvents` imports outside `forge-adapter/github/`.
4. `we:scripts/lib/pr-event-feed.mjs:331` — Add a contract test that every `{ok:false, route}` result from the port is surfaced by each core consumer. File it with the reinforce-later card.
5. `we:scripts/conveyor/pr-events-worker/__tests__/app-webhook.test.mjs:17` — Add a deterministic parameterized test covering each signing secret with both bindings configured.
6. `we:scripts/lib/forge-adapter/change-events.mjs:20` — Add deterministic table-driven cursor-consistency tests for empty and nonempty pages, including matching and mismatched returned cursors.
7. `we:scripts/lib/forge-adapter/change-events.mjs:13` — Add a mandatory parameterized port-contract test covering non-array events, invalid cursors, and unsafe sequence integers, asserting an error or gap for each.
8. `we:scripts/lib/forge-adapter/__tests__/change-events.test.mjs:23` — Require consumer integration tests using the default port wiring and a controlled clock, asserting disabled defaults, continued periodic ticks after failure, full-sweep invocation after a gap, and live-state reads before decisions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7459@a5fad2fba128abc04b9a54cd28d519abe6fa5360

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
