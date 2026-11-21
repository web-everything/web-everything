---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/provider-capacity.mjs", "we:scripts/lib/routing-settings.mjs", "we:scripts/lib/provider-capacity-io.mjs", "we:scripts/lib/dispatch-routing-policy-io.mjs", "we:scripts/lib/__tests__/provider-capacity.test.mjs", "we:scripts/lib/__tests__/routing-settings.test.mjs", "we:scripts/lib/__tests__/provider-capacity-io.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy-io.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Give the capacity list one helper that returns unique quotas (drop quotaOf rows) and use it in ev… (from web-everything/web-everything#7169 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/provider-capacity.mjs:172` — Give the capacity list one helper that returns unique quotas (drop `quotaOf` rows) and use it in every planner and emitter. Add a property test that any `quotaOf` alias never adds an event, burn row or horizon entry.
2. `we:scripts/lib/routing-settings.mjs:64` — Add a retention or compaction rule for the ledger. Add a test that a ledger larger than the tail still yields a rate from the last 6h of rows. File this as a backlog card.
3. `we:scripts/lib/provider-capacity-io.mjs:80` — Parameterise the dedupe test over every event kind that burnWindows can return, with a unit test asserting the set of emitted kinds is exhaustively covered.
4. `we:scripts/lib/dispatch-routing-policy-io.mjs:99` — Add a table-driven test that runs every scoped provider pin under `builder` = claude, codex and auto, with Codex usage below and above the threshold, and asserts that the Codex hold matches the unpinned path. A lint that requires every early return in `resolveDispatchRoute` to set `availability.codex` for build kinds would also catch this.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7169@6566cd2c02c6811bef351f7aa5028ca3f357edc5

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
