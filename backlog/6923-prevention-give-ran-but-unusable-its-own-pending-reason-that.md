---
bornAs: xzjfr58
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-saved-red-team.mjs", "we:docs/agent/testing.md", "we:scripts/lib/__tests__/drain-saved-red-team.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Give ran-but-unusable its own pending reason that triggers a re-run request or a bounded retry co… (from web-everything/web-everything#5551 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-saved-red-team.mjs:72` — Give ran-but-unusable its own pending reason that triggers a re-run request or a bounded retry count and then a human-visible hold. The never-scheduled enqueue would then only be reachable when no run exists. Add a drain-merge-strategy test asserting that an unparseable/error run does not enqueue via the never-scheduled path.
2. `we:docs/agent/testing.md:88` — Add the named integration test in we:scripts/lib/__tests__/drain-merge-strategy.test.mjs, seeding incomplete saved evidence, then supplying a trusted same-head result and asserting enqueue succeeds and pending state clears.
3. `we:docs/agent/testing.md:89` — Add 'trusted posted live-head result releases a persisted incomplete saved hold' in we:scripts/lib/__tests__/drain-merge-strategy.test.mjs, asserting enqueue and removal of the persisted pending state.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5551@e06e32a0a60029096637651ffa481074eb70c957

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
